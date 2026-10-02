import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  OperationId,
  PROJECT_CONFIG_FILE,
  PlanId,
  SNAPSHOT_METADATA_SCHEMA_VERSION,
  SnapshotId,
  canonicalJson,
  formatCommitMessage,
  isSafeRelativePath,
  parseProjectConfig,
  type CollisionReason,
  type CommitRef,
  type ErrorCode,
  type JsonValue,
  type Origin,
  type ProjectConfig,
  type ProjectId,
  type ProjectSummary,
  type RestoreChange,
  type RestoreCollision,
  type RestoreJournal,
  type RestorePlan,
  type RestorePlanRecord,
  type RestoreProgress,
  type RestoreResult,
  type SnapshotMetadata,
  type UnsupportedEntry,
} from '@draft-tide/contracts';
import { SPACE_MARGIN_BYTES, captureScope } from './capture.ts';
import { diffTreeFiles, takeWithinBudget, type TreeFileAt } from './compare.ts';
import type { ProjectContext, WriteRun } from './context.ts';
import { resolveVersionRef, versionInfoOf } from './history.ts';
import { operationError } from './journal.ts';
import { compareGitPaths, findPathCollisions, mapLimit } from './paths.ts';
import type {
  FileState,
  GitBlobMode,
  GitListing,
  GitOid,
  GitTreeEntry,
  OperationFile,
  OperationRecord,
  ProjectGit,
  RepoProbe,
  Workspace,
} from './ports.ts';
import { probeForWrite, recordCapture } from './save.ts';
import {
  assertNoBlockers,
  assertSupportedEntries,
  attributeVerdict,
  blobMode,
  excludeRules,
  lineEndingBlocker,
  scanScope,
} from './scope.ts';
import { sha256Hex } from './text.ts';

// Restoring a version (M1 plan §9.2–9.3). History is only ever added to:
//
//   V1 → V2 → V3 → [P: pre-restore, if the folder had unsaved changes] → R: content of V1
//
// plan   reads the folder and the version, says what would be overwritten,
//        added and deleted, and stores a fingerprint of what it saw. Nothing
//        is written but the plan's row.
// apply  under the project's write guard: captures the folder (the same
//        stable capture a save makes) and refuses with PLAN_STALE unless it
//        still matches the plan; records the unsaved changes as P; writes
//        and deletes files one at a time, each only if it still holds what
//        the capture saw; reads the result back; records R lock-first.
//
// Once the first file is written the operation is past its point of no
// return: an external change, a failed write or a lost publish stops it in
// `recovery-required`, never rolled back silently over someone's new work.
// Files outside what Draft Tide saves are never written or deleted; one in the
// way of the version is a collision (UNTRACKED_FILES).

const MAX_CHANGES_BYTES = 640 * 1024;
const MAX_CHANGES = 5000;
const MAX_COLLISIONS = 100;
// Files changed this recently may still be being written.
const RECENT_MS = 10_000;
const FOLDER_LISTING_MAX = 10_000;

export interface RecoveryGate {
  // Under the project's write guard, before a change: completes what can be
  // completed without asking, then refuses (RECOVERY_REQUIRED) while
  // anything that needs a decision is left.
  beforeWrite(p: ProjectSummary, repo: ProjectGit): Promise<void>;
  // Read-only: something needs the user's decision first.
  needsDecision(p: ProjectSummary, repo: ProjectGit): Promise<boolean>;
}

export interface RestoreService {
  plan(projectId: ProjectId, target: string): Promise<RestorePlan>;
  apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<RestoreResult>;
}

// ---- What a version's tree may hold to be restored

export interface RestoreFile {
  path: string;
  mode: GitBlobMode;
  oid: GitOid;
  size: number;
}

// Only regular files with safe, distinct names can be written back. Other
// tools may have committed symlinks, submodules or names this filesystem
// can't hold apart; the version is then refused as a whole, never partly
// restored.
export function restorableFiles(listing: GitListing<GitTreeEntry>): RestoreFile[] {
  const refused: UnsupportedEntry[] = listing.nonUtf8.map((path) => ({ path, kind: 'non-utf8-name' }));
  const files: RestoreFile[] = [];
  for (const e of listing.entries) {
    if (!isSafeRelativePath(e.path)) refused.push({ path: e.path, kind: 'invalid-name' });
    else if (e.mode === '120000') refused.push({ path: e.path, kind: 'symlink' });
    else if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755') || e.size === null) {
      refused.push({ path: e.path, kind: 'special' });
    } else files.push({ path: e.path, mode: e.mode, oid: e.oid, size: e.size });
  }
  for (const group of findPathCollisions(files.map((f) => f.path))) {
    for (const path of group) refused.push({ path, kind: 'path-collision' });
  }
  if (refused.length > 0) {
    refused.sort((a, b) => compareGitPaths(a.path, b.path));
    throw new DtError('UNSUPPORTED_ENTRY', "this version holds items that can't be restored into a folder", {
      reason: 'version-not-restorable',
      count: refused.length,
      entries: refused.slice(0, 50) as unknown as JsonValue,
    });
  }
  return files;
}

// ---- The folder as it is

export interface LiveFile extends FileState {
  path: string;
  size: number;
  mtimeNs: bigint;
}

// Every file in scope with its content id, read the way a save reads it.
// Anything that would stop a save stops the plan.
async function readLiveFolder(
  ctx: ProjectContext,
  projectId: ProjectId,
  repo: ProjectGit,
  workspace: Workspace,
  probe: RepoProbe,
  config: ProjectConfig,
): Promise<LiveFile[]> {
  const scan = await scanScope(repo, workspace, excludeRules(config));
  assertNoBlockers(scan.blockers);
  assertSupportedEntries(scan.unsupported);
  const attrs = attributeVerdict(await repo.checkAttributes(scan.files.map((f) => f.path)));
  assertNoBlockers(attrs.blockers);
  const cache = ctx.hashCache(projectId);
  const nowMs = Date.parse(ctx.clock.nowIso());
  const changing: string[] = [];
  const withCR: string[] = [];
  const files = await mapLimit(scan.files, 8, async (f) => {
    let digest = cache.get(f.path, f.identity);
    if (!digest) {
      const r = await workspace.hash(f.path, f.identity);
      if (r.changed) {
        changing.push(f.path);
        return null;
      }
      digest = r.digest;
      cache.set(f.path, f.identity, digest, nowMs);
    }
    if (digest.hasCR && attrs.convertingPaths.has(f.path)) withCR.push(f.path);
    const live: LiveFile = {
      path: f.path,
      oid: digest.oid,
      mode: blobMode(digest.executable, f.tracked, probe.trustExecutableBit),
      size: digest.size,
      mtimeNs: f.identity.mtimeNs > f.identity.ctimeNs ? f.identity.mtimeNs : f.identity.ctimeNs,
    };
    return live;
  });
  if (changing.length > 0) {
    throw new DtError(
      'SOURCE_BUSY',
      'files are changing in the folder; stop the tool that is writing to it and check again',
      { changed: changing.sort(compareGitPaths).slice(0, 20) },
    );
  }
  const lineEndings = lineEndingBlocker(withCR);
  if (lineEndings) assertNoBlockers([lineEndings]);
  return files.filter((f): f is LiveFile => f !== null);
}

// The folder's own `.drafttide.json`, which must name this project.
async function currentConfig(
  workspace: Workspace,
  projectId: ProjectId,
): Promise<{ config: ProjectConfig; oid: GitOid }> {
  const read = await workspace.readProjectConfig();
  if (!read)
    throw new DtError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE}: the project settings file is missing`, {
      reason: 'missing',
    });
  if (read.config.projectId !== projectId) {
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the folder's .drafttide.json names another project", {
      reason: 'project-mismatch',
    });
  }
  return read;
}

// A blob's bytes, or null when it is larger than max.
export async function readSmallBlob(repo: ProjectGit, oid: GitOid, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of repo.streamBlob(oid)) {
    length += chunk.byteLength;
    if (length > max) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface SettingsDecision {
  action: RestorePlan['settings']['action'];
  reason: RestorePlan['settings']['reason'];
  // The current settings blob, kept in place of the version's.
  keptBlob: GitOid | null;
  files: RestoreFile[];
}

// `.drafttide.json` comes back with the version (M1 plan §9.2) when the
// version's copy names this project. Otherwise (a version from before Draft
// Tide, a copy connected as a new project, a file someone broke) restoring it
// would cut the folder off from its project: the current file stays.
async function settingsFor(
  repo: ProjectGit,
  files: readonly RestoreFile[],
  projectId: ProjectId,
  current: { oid: GitOid; size: number },
): Promise<SettingsDecision> {
  const theirs = files.find((f) => f.path === PROJECT_CONFIG_FILE);
  let reason: SettingsDecision['reason'] = null;
  if (!theirs) reason = 'missing';
  else {
    const bytes = await readSmallBlob(repo, theirs.oid, MAX_PROJECT_CONFIG_BYTES);
    try {
      if (bytes === null) reason = 'invalid';
      else if (parseProjectConfig(bytes).projectId !== projectId) reason = 'other-project';
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'CONFIG_INVALID') throw e;
      reason = 'invalid';
    }
  }
  if (reason === null && theirs) {
    return { action: theirs.oid === current.oid ? 'unchanged' : 'restored', reason, keptBlob: null, files: [...files] };
  }
  const kept: RestoreFile = { path: PROJECT_CONFIG_FILE, mode: '100644', oid: current.oid, size: current.size };
  const rest = files.filter((f) => f.path !== PROJECT_CONFIG_FILE);
  const merged = [...rest, kept].sort((a, b) => compareGitPaths(a.path, b.path));
  return { action: 'kept', reason, keptBlob: current.oid, files: merged };
}

// ---- What applying changes

export interface PlannedWrite {
  path: string;
  before: FileState | null;
  after: FileState;
  size: number;
}

export interface PlannedChanges {
  writes: PlannedWrite[];
  deletes: { path: string; before: FileState }[];
  unchanged: number;
}

export function plannedChanges(
  live: readonly (FileState & { path: string })[],
  restore: readonly RestoreFile[],
): PlannedChanges {
  const now = new Map(live.map((f) => [f.path, f]));
  const wanted = new Set(restore.map((f) => f.path));
  const writes: PlannedWrite[] = [];
  let unchanged = 0;
  for (const r of restore) {
    const l = now.get(r.path);
    if (l && l.oid === r.oid && l.mode === r.mode) unchanged++;
    else
      writes.push({
        path: r.path,
        before: l ? { oid: l.oid, mode: l.mode } : null,
        after: { oid: r.oid, mode: r.mode },
        size: r.size,
      });
  }
  const deletes = live
    .filter((l) => !wanted.has(l.path))
    .map((l) => ({ path: l.path, before: { oid: l.oid, mode: l.mode } }));
  return { writes, deletes, unchanged };
}

const fold = (p: string) => p.normalize('NFC').toLowerCase();

// Paths the restore adds where something Draft Tide doesn't save is in the
// way (M1 plan §9.2): never overwritten or deleted. An in-scope file the
// restore deletes first doesn't count: neither at its own name, nor as the
// other spelling a case-insensitive filesystem resolves the new name to (a
// case-only rename). Anything that exists spelled exactly as the new name and
// isn't deleted is in the way.
export async function findCollisions(workspace: Workspace, changes: PlannedChanges): Promise<RestoreCollision[]> {
  const deleted = new Set(changes.deletes.map((d) => d.path));
  const deletedFolded = new Set(changes.deletes.map((d) => fold(d.path)));
  const added = changes.writes.filter((w) => w.before === null).map((w) => w.path);
  const prefixes = new Set<string>();
  for (const p of added) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('/'));
  }
  const paths = [...prefixes, ...added];
  const index = new Map(paths.map((p, i) => [p, i]));
  const [occupants, exact] = await Promise.all([workspace.occupants(paths), workspace.exactNames(paths)]);
  const at = (p: string) => occupants[index.get(p) as number] ?? 'missing';
  // A file that goes before the new name is written.
  const goesFirst = (p: string) =>
    deleted.has(p) || (!(exact[index.get(p) as number] ?? false) && deletedFolded.has(fold(p)));
  const collisions: RestoreCollision[] = [];
  for (const p of added) {
    const parts = p.split('/');
    let reason: CollisionReason | null = null;
    for (let i = 1; i < parts.length && reason === null; i++) {
      const q = parts.slice(0, i).join('/');
      const o = at(q);
      if (o === 'missing') break;
      if (o === 'folder') continue;
      if (o !== 'file' || !goesFirst(q)) reason = 'parent';
      break;
    }
    if (reason === null) {
      const o = at(p);
      if (o === 'file' && !goesFirst(p)) reason = 'unsaved-file';
      else if (o === 'link' || o === 'other') reason = 'link';
      else if (o === 'folder') {
        const inside = await workspace.listFolder(p, FOLDER_LISTING_MAX);
        if (!inside.complete || inside.entries.some((e) => !deleted.has(e) && !deletedFolded.has(fold(e)))) {
          reason = 'folder';
        }
      }
    }
    if (reason !== null) collisions.push({ path: p, reason });
  }
  return collisions.sort((a, b) => compareGitPaths(a.path, b.path));
}

// Names exactly what the plan was made against: the branch and its tip, the
// version, the settings decision, every file in scope with its content, and
// what is in the way. The apply recomputes it from its own capture.
export function restoreFingerprint(args: {
  root: string;
  ref: string;
  tip: GitOid;
  target: GitOid;
  keptSettings: GitOid | null;
  live: readonly (FileState & { path: string })[];
  collisions: readonly RestoreCollision[];
}): Promise<string> {
  return sha256Hex(
    canonicalJson({
      root: args.root,
      ref: args.ref,
      tip: args.tip,
      target: args.target,
      keptSettings: args.keptSettings,
      live: [...args.live].sort((a, b) => compareGitPaths(a.path, b.path)).map((f) => [f.path, f.oid, f.mode]),
      collisions: args.collisions.map((c) => [c.path, c.reason]),
    }),
  );
}

function stale(reason: string, message: string): DtError {
  return new DtError('PLAN_STALE', message, { reason });
}

// The plan a caller names, for this project, still unused and unexpired.
export function usablePlan(ctx: ProjectContext, projectId: ProjectId, planId: PlanId, kind: 'restore' | 'recovery') {
  const plan = ctx.store.getPlan(planId);
  if (!plan || plan.record.kind !== kind) {
    throw new DtError('INVALID_ARGUMENT', `no ${kind} plan has this id`, { reason: 'unknown-plan' });
  }
  if (plan.projectId !== projectId) {
    throw new DtError('INVALID_ARGUMENT', 'this plan belongs to another project', {
      reason: 'plan-of-another-project',
    });
  }
  if (plan.consumedBy !== null) throw stale('used', 'this plan was already applied; make a new one');
  if (Date.parse(ctx.clock.nowIso()) > Date.parse(plan.expiresAt)) {
    throw stale('expired', 'this plan has expired; check the restore again');
  }
  return plan;
}

// The tool channel's apply re-checks agent access inside the guard and
// again before the first file is written (M1 plan §9.3 step 2).
export function accessCheck(ctx: ProjectContext, origin: Origin): () => void {
  return () => {
    if (origin !== 'gui' && !ctx.store.getAgentAccess().enabled) {
      throw new DtError(
        'AGENT_ACCESS_DISABLED',
        'Agent access was turned off. Ask the user to turn it on in the Draft Tide app (Settings).',
      );
    }
  };
}

const NO_CONFLICTS = { count: 0, sample: [] as string[] };

// Writes one planned change, expecting `from` and leaving `to` (null: the
// file is absent). The file's bytes come from Git.
export async function transition(
  repo: ProjectGit,
  workspace: Workspace,
  path: string,
  from: FileState | null,
  to: FileState | null,
): Promise<boolean> {
  if (to === null) {
    if (from === null) return true;
    return !(await workspace.removeFile(path, from.oid)).changed;
  }
  const outcome = await workspace.writeFile(path, repo.streamBlob(to.oid), {
    mode: to.mode,
    expected: from?.oid ?? null,
    oid: to.oid,
  });
  return !outcome.changed;
}

// Where each file is now, against the states a change moves it between.
export async function fileStates(
  workspace: Workspace,
  files: readonly OperationFile[],
  trustExecutableBit: boolean,
): Promise<('before' | 'after' | 'neither')[]> {
  const paths = files.map((f) => f.path);
  const [inspected, exact] = await Promise.all([workspace.inspect(paths), workspace.exactNames(paths)]);
  return mapLimit(files, 8, async (f, i) => {
    const r = inspected[i];
    let now: FileState | null = null;
    // Another spelling of this name (a case-only rename in progress) is
    // another file: this one is absent.
    if (r?.kind === 'file' && exact[i]) {
      const d = await workspace.hash(f.path, r.identity);
      if (d.changed) return 'neither';
      now = {
        oid: d.digest.oid,
        mode: d.digest.executable ? '100755' : '100644',
      };
    } else if (r?.kind !== 'missing' && r?.kind !== 'file') return 'neither';
    const same = (want: FileState | null) =>
      want === null
        ? now === null
        : now !== null && now.oid === want.oid && (!trustExecutableBit || now.mode === want.mode);
    if (same(f.after)) return 'after';
    if (same(f.before)) return 'before';
    return 'neither';
  });
}

export function createRestoreService(ctx: ProjectContext, recovery: RecoveryGate): RestoreService {
  const { store, clock, journal } = ctx;

  async function plan(projectId: ProjectId, ref: string): Promise<RestorePlan> {
    const p = ctx.requireProject(projectId);
    const { root, repo, workspace } = await ctx.openBound(p);
    const probe = await ctx.readableRepo(repo);
    assertNoBlockers(probe.blockers);
    if (probe.tip === null) {
      throw new DtError('SNAPSHOT_NOT_FOUND', 'the project has no versions yet', { ref });
    }
    const index = await ctx.lineIndex(projectId, repo, probe.tip);
    const targetOid = resolveVersionRef(index, ref);
    const [target, base] = await repo.readCommits([targetOid, probe.tip]);
    if (!target || !base) throw new DtError('GIT_FAILED', 'a version could not be read');
    const files = restorableFiles(await repo.listTree(target.tree));
    const config = await currentConfig(workspace, projectId);
    const live = await readLiveFolder(ctx, projectId, repo, workspace, probe, config.config);
    const liveConfig = live.find((f) => f.path === PROJECT_CONFIG_FILE);
    if (!liveConfig || liveConfig.oid !== config.oid) {
      throw new DtError('SOURCE_BUSY', 'the project settings changed while the folder was read; check again', {});
    }
    const settings = await settingsFor(repo, files, projectId, liveConfig);
    const changes = plannedChanges(live, settings.files);
    const collisions = await findCollisions(workspace, changes);
    const tipFiles = (await repo.listTree(base.tree)).entries.filter((e) => e.mode === '100644' || e.mode === '100755');
    const asTree = (f: { path: string; mode: string; oid: GitOid; size: number | null }): TreeFileAt => ({
      path: f.path,
      mode: f.mode,
      oid: f.oid,
      size: f.size,
    });
    const unsaved = diffTreeFiles(tipFiles.map(asTree), live.map(asTree)).summary.total;
    const requiredBytes = changes.writes.reduce((n, w) => n + w.size, 0);
    const availableBytes = await workspace.projectSpace().then(
      (s) => Math.max(0, Math.floor(s.availableBytes)),
      () => null,
    );
    const recentCutoff = BigInt(Date.parse(clock.nowIso()) - RECENT_MS) * 1_000_000n;
    const recent = live.filter((f) => f.mtimeNs >= recentCutoff).map((f) => f.path);
    const noop = changes.writes.length === 0 && changes.deletes.length === 0;

    let blocked: ErrorCode | null = null;
    if (await recovery.needsDecision(p, repo)) blocked = 'RECOVERY_REQUIRED';
    else if (collisions.length > 0) blocked = 'UNTRACKED_FILES';
    else if (availableBytes !== null && availableBytes < requiredBytes + SPACE_MARGIN_BYTES) {
      blocked = 'INSUFFICIENT_DISK_SPACE';
    }

    const fingerprint = await restoreFingerprint({
      root,
      ref: probe.headRef,
      tip: probe.tip,
      target: target.oid,
      keptSettings: settings.keptBlob,
      live,
      collisions,
    });
    const targetInfo = versionInfoOf(target, index);
    const record: RestorePlanRecord = {
      kind: 'restore',
      ref: probe.headRef,
      baseTip: probe.tip,
      target: { commit: target.oid, snapshotId: targetInfo.snapshotId },
      targetTree: target.tree,
      settingsBlob: settings.keptBlob,
    };
    const createdAt = clock.nowIso();
    const planId = PlanId.parse(crypto.randomUUID());
    const expiresAt = new Date(Date.parse(createdAt) + ctx.planTtlMs).toISOString();
    store.insertPlan({ planId, projectId, createdAt, expiresAt, fingerprint, record, consumedBy: null });

    const listed: RestoreChange[] = [
      ...changes.writes.map((w): RestoreChange => ({ path: w.path, change: w.before ? 'overwrite' : 'add' })),
      ...changes.deletes.map((d): RestoreChange => ({ path: d.path, change: 'delete' })),
    ].sort((a, b) => compareGitPaths(a.path, b.path));
    const { taken, truncated } = takeWithinBudget(listed.slice(0, MAX_CHANGES), MAX_CHANGES_BYTES);
    return {
      planId,
      projectId,
      createdAt,
      expiresAt,
      branch: probe.branch,
      base: versionInfoOf(base, index),
      target: targetInfo,
      summary: {
        overwrite: changes.writes.filter((w) => w.before !== null).length,
        add: changes.writes.filter((w) => w.before === null).length,
        delete: changes.deletes.length,
        unchanged: changes.unchanged,
      },
      changes: taken,
      truncated: truncated || listed.length > MAX_CHANGES,
      protection: { needed: unsaved > 0 && !noop, unsavedChanges: unsaved },
      settings: { action: settings.action, reason: settings.reason },
      collisions: { count: collisions.length, entries: collisions.slice(0, MAX_COLLISIONS) },
      space: { requiredBytes, availableBytes },
      writers: {
        draftTideBusy: ctx.guards.isBusy(projectId),
        recentlyModified: { count: recent.length, sample: recent.sort(compareGitPaths).slice(0, 50) },
      },
      blocked,
      noop,
    };
  }

  async function apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<RestoreResult> {
    const p = ctx.requireProject(projectId);
    const stored = usablePlan(ctx, projectId, planId, 'restore');
    const record = stored.record as RestorePlanRecord;
    const operationId = OperationId.parse(crypto.randomUUID());
    const begun: OperationRecord = {
      operationId,
      projectId,
      kind: 'restore',
      origin,
      state: 'confirmed',
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
      acknowledged: false,
      journal: {
        kind: 'restore',
        planId,
        ref: record.ref,
        baseTip: record.baseTip,
        target: record.target,
        targetTree: record.targetTree,
        settingsBlob: record.settingsBlob,
        restoreTree: null,
        protection: null,
        parent: null,
        publish: null,
        restored: null,
        reason: null,
        conflicts: NO_CONFLICTS,
        error: null,
      },
    };
    // Accepting the apply and starting the operation are one transaction.
    if (!store.consumePlan(planId, operationId, begun.createdAt, begun)) {
      throw stale('used', 'this plan was already applied; make a new one');
    }
    const op = { operationId, activity: 'restoring' as const, origin };
    const report = ctx.progressReporter({ ...op, projectId }, 'restore.apply');
    // Said at once, so the app knows the operation (and can cancel it) even
    // while it waits for an earlier change of the project.
    report({ stage: 'check', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    const settled = (outcome: 'completed' | 'no-changes' | 'failed' | 'cancelled' | 'recovery-required', e?: unknown) =>
      ctx.publish({
        name: 'operation.settled',
        operationId,
        projectId,
        operation: 'restore.apply',
        origin,
        outcome,
        code: e === undefined ? null : operationError(e).code,
      });

    const state = { rec: begun };
    try {
      const result = await ctx.runWrite(projectId, op, async (run) => {
        try {
          run.signal.throwIfAborted();
          return await applyRestore(state, p, stored.fingerprint, origin, run, report);
        } catch (caught) {
          throw settleFailure(state, caught);
        }
      });
      settled('completed');
      ctx.publish({ name: 'project.changed', projectId, reason: 'restored' });
      if (origin !== 'gui') ctx.publish({ name: 'operations.changed' });
      return result;
    } catch (e) {
      const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
      const outcome =
        state.rec.state === 'recovery-required' || state.rec.state === 'publishing'
          ? 'recovery-required'
          : code === 'NO_CHANGES'
            ? 'no-changes'
            : code === 'CANCELLED'
              ? 'cancelled'
              : 'failed';
      settled(outcome, e);
      if (outcome === 'recovery-required') ctx.publish({ name: 'operations.changed' });
      if (state.rec.journal.kind === 'restore' && state.rec.journal.protection) {
        ctx.publish({ name: 'project.changed', projectId, reason: 'saved' });
      }
      throw e;
    } finally {
      ctx.dropCaches(projectId);
    }
  }

  // Under the guard: what a failure leaves in the journal, and what the caller
  // is told. Steps that fail inside applyRestore record themselves; this
  // covers the rest.
  function settleFailure(state: { rec: OperationRecord }, caught: unknown): unknown {
    const rec = state.rec;
    const j = rec.journal as RestoreJournal;
    // Files may have been written: whatever stopped it, recovery decides.
    if (rec.state === 'applying' || rec.state === 'verified') {
      const reason = rec.state === 'verified' ? 'not-recorded' : 'write-failed';
      state.rec = journal.move(rec, 'recovery-required', { ...j, reason, error: operationError(caught) });
      return new DtError(
        'RECOVERY_REQUIRED',
        'the restore stopped part-way; nothing was lost. Finish it or put the files back from the recovery screen',
        { operationId: rec.operationId, reason },
      );
    }
    // Not started (cancelled while it waited), or stopped before its checks.
    if (rec.state === 'confirmed' || rec.state === 'preflight') {
      const cancelled = caught instanceof DtError && caught.code === 'CANCELLED';
      state.rec = journal.move(rec, cancelled ? 'cancelled' : 'failed', { ...j, error: operationError(caught) });
    }
    return caught;
  }

  async function applyRestore(
    state: { rec: OperationRecord },
    p: ProjectSummary,
    fingerprint: string,
    origin: Origin,
    run: WriteRun,
    report: (progress: RestoreProgress) => void,
  ): Promise<RestoreResult> {
    const projectId = p.projectId;
    const operationId = state.rec.operationId;
    const { signal } = run;
    const checkAccess = accessCheck(ctx, origin);
    const j = () => state.rec.journal as RestoreJournal;
    const move = (to: OperationRecord['state'], patch: Partial<RestoreJournal> = {}) => {
      state.rec = journal.move(state.rec, to, { ...j(), ...patch });
    };
    const fail = (to: 'failed' | 'cancelled', e: unknown) => move(to, { error: operationError(e) });

    move('preflight');
    await ctx.hooks.checkpoint?.('restore:preflight');
    let staging: Awaited<ReturnType<typeof ctx.host.createStaging>> | null = null;
    const { root, repo, workspace } = await ctx.openBound(p);
    let files: OperationFile[];
    const sizes = new Map<string, number>();
    let trustExec: boolean;
    try {
      checkAccess();
      await recovery.beforeWrite(p, repo);
      const probe = await probeForWrite(repo, signal);
      trustExec = probe.trustExecutableBit;
      if (probe.headRef !== j().ref || probe.tip !== j().baseTip) {
        throw stale('history-changed', 'the history changed since the plan was made; check the restore again');
      }
      const lock = await repo.indexLock();
      if (lock.held) {
        throw new DtError('LOCKED', 'another Git program is using this repository right now; nothing was changed', {
          lock: 'index',
        });
      }

      // The folder, captured the way a save captures it: the plan's check and
      // the pre-restore version come from the same reading.
      staging = await ctx.host.createStaging(projectId, operationId);
      const capture = await captureScope({
        repo,
        workspace,
        staging,
        probe,
        projectId,
        signal,
        onProgress: (c) =>
          report({
            stage: 'check',
            filesDone: c.filesDone,
            filesTotal: c.filesTotal,
            bytesDone: c.bytesDone,
            bytesTotal: c.bytesTotal,
          }),
        ...(ctx.options.retryDelayMs ? { retryDelayMs: ctx.options.retryDelayMs } : {}),
      });
      const [target] = await repo.readCommits([j().target.commit]);
      if (!target) throw new DtError('GIT_FAILED', 'the version could not be read');
      const restoreFiles = restorableFiles(await repo.listTree(target.tree));
      const config = capture.files.find((f) => f.path === PROJECT_CONFIG_FILE);
      if (!config) throw new DtError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE}: missing`, { reason: 'missing' });
      const settings = await settingsFor(repo, restoreFiles, projectId, config);
      const changes = plannedChanges(capture.files, settings.files);
      const collisions = await findCollisions(workspace, changes);
      const now = await restoreFingerprint({
        root,
        ref: probe.headRef,
        tip: probe.tip,
        target: target.oid,
        keptSettings: settings.keptBlob,
        live: capture.files,
        collisions,
      });
      if (now !== fingerprint || settings.keptBlob !== j().settingsBlob) {
        throw stale('changed', 'files changed since the plan was made; check the restore again');
      }
      if (changes.writes.length === 0 && changes.deletes.length === 0) {
        throw new DtError('NO_CHANGES', 'the folder already matches this version', {});
      }
      if (collisions.length > 0) {
        throw new DtError(
          'UNTRACKED_FILES',
          'files that no version holds are in the way; move them or save them first, then check again',
          { count: collisions.length, entries: collisions.slice(0, 50) as unknown as JsonValue },
        );
      }
      const space = await workspace.projectSpace();
      const required = changes.writes.reduce((n, w) => n + w.size, 0) + SPACE_MARGIN_BYTES;
      if (space.availableBytes < required) {
        throw new DtError('INSUFFICIENT_DISK_SPACE', 'not enough free disk space to restore this version', {
          volume: 'project',
          requiredBytes: required,
          availableBytes: space.availableBytes,
        });
      }
      signal.throwIfAborted();

      // The unsaved changes become the pre-restore version (M1 plan §9.3
      // step 4). A folder that equals its newest commit needs none.
      report({ stage: 'protect', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
      let protection: CommitRef | null = null;
      try {
        const saved = await recordCapture(capture, {
          repo,
          probe,
          operationId,
          origin,
          kind: 'pre-restore',
          identity: ctx.identity,
          clock,
          signal,
          onPublish: (intent) => move('publishing', { publish: intent }),
          ...(ctx.options.lockWaitMs !== undefined ? { lockWaitMs: ctx.options.lockWaitMs } : {}),
        });
        protection = { commit: saved.commit, snapshotId: saved.snapshotId };
      } catch (e) {
        if (!(e instanceof DtError) || e.code !== 'NO_CHANGES') throw e;
      }
      move('protected', { protection, parent: protection?.commit ?? j().baseTip, publish: null });
      await ctx.hooks.checkpoint?.('restore:protected');

      files = [
        ...changes.deletes.map((d) => ({ path: d.path, before: d.before, after: null })),
        ...changes.writes.map((w) => ({ path: w.path, before: w.before, after: w.after })),
      ].map((f, seq): OperationFile => ({ ...f, seq, done: false }));
      for (const w of changes.writes) sizes.set(w.path, w.size);
      store.insertOperationFiles(operationId, files);
      move('staged');
      await ctx.hooks.checkpoint?.('restore:staged');
      await staging.remove().catch(() => undefined);
      staging = null;

      // Last checks before the first file: Git's index still free (so the
      // files never change while the version can't be recorded), still
      // allowed, not cancelled. Nothing awaits between the cancel check and
      // the point of no return, so a cancel can't slip in between.
      if ((await repo.indexLock()).held) {
        throw new DtError('LOCKED', 'another Git program is using this repository right now; nothing was changed', {
          lock: 'index',
        });
      }
      checkAccess();
      signal.throwIfAborted();
      run.pastPointOfNoReturn();
    } catch (e) {
      // The pre-restore version is in history but Git's index wasn't
      // switched to it: recovery completes that from the journal.
      if (state.rec.state === 'publishing' && e instanceof DtError && e.code === 'RECOVERY_REQUIRED') throw e;
      fail(e instanceof DtError && e.code === 'CANCELLED' ? 'cancelled' : 'failed', e);
      throw e;
    } finally {
      await staging?.remove().catch(() => undefined);
    }

    // ---- Past the point of no return.
    move('applying');
    const bytesTotal = [...sizes.values()].reduce((n, size) => n + size, 0);
    let bytesDone = 0;
    let written = 0;
    let deleted = 0;
    const needRecovery = (reason: RestoreJournal['reason'], e: unknown, conflicts: string[] = []) => {
      move('recovery-required', {
        reason,
        error: operationError(e),
        conflicts: { count: conflicts.length, sample: conflicts.slice(0, 50) },
      });
      return new DtError(
        'RECOVERY_REQUIRED',
        'the restore stopped part-way; nothing was lost. Finish it or put the files back from the recovery screen',
        { operationId, reason },
      );
    };
    for (const f of files) {
      let ok: boolean;
      try {
        ok = await transition(repo, workspace, f.path, f.before, f.after);
      } catch (e) {
        if (written + deleted === 0) {
          fail('failed', e);
          throw e;
        }
        throw needRecovery('write-failed', e);
      }
      if (!ok) {
        const e = stale('external-change', 'a file changed while the restore was writing; it was left as it is');
        if (written + deleted === 0) {
          fail('failed', e);
          throw e;
        }
        throw needRecovery('external-change', e, [f.path]);
      }
      if (f.after === null) deleted++;
      else written++;
      bytesDone += sizes.get(f.path) ?? 0;
      store.markOperationFile(operationId, f.seq, true);
      report({ stage: 'apply', filesDone: written + deleted, filesTotal: files.length, bytesDone, bytesTotal });
      await ctx.hooks.checkpoint?.('restore:file', { path: f.path, index: written + deleted });
    }

    // Read every changed file back (M1 plan §9.3 step 8).
    report({ stage: 'verify', filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: 0 });
    const states = await fileStates(workspace, files, trustExec);
    const off = files.filter((_, i) => states[i] !== 'after').map((f) => f.path);
    if (off.length > 0) {
      throw needRecovery('verify-failed', new DtError('PLAN_STALE', 'files changed after they were written'), off);
    }
    move('verified');
    await ctx.hooks.checkpoint?.('restore:verified');
    return recordRestore(ctx, state, { repo, report, origin });
  }

  return { plan, apply };
}

// Records the restore version on the branch tip it must go on and publishes
// it lock-first. Shared with recovery's finish.
export async function recordRestore(
  ctx: ProjectContext,
  state: { rec: OperationRecord },
  args: {
    repo: ProjectGit;
    origin: Origin;
    report?: (progress: RestoreProgress) => void;
    // Recovery builds on whatever the branch holds now.
    parent?: GitOid;
  },
): Promise<RestoreResult> {
  const { journal, clock } = ctx;
  const { repo } = args;
  const rec = () => state.rec;
  const j = () => rec().journal as RestoreJournal;
  const move = (to: OperationRecord['state'], patch: Partial<RestoreJournal> = {}) => {
    state.rec = journal.move(state.rec, to, { ...j(), ...patch });
  };
  const operationId = rec().operationId;
  args.report?.({ stage: 'publish', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });

  const parent = args.parent ?? j().parent ?? j().baseTip;
  let tree: GitOid;
  if (j().settingsBlob !== null) {
    const [target] = await repo.readCommits([j().target.commit]);
    if (!target) throw new DtError('GIT_FAILED', 'the version could not be read');
    const files = restorableFiles(await repo.listTree(target.tree))
      .filter((f) => f.path !== PROJECT_CONFIG_FILE)
      .map((f) => ({ path: f.path, mode: f.mode, oid: f.oid }));
    files.push({ path: PROJECT_CONFIG_FILE, mode: '100644', oid: j().settingsBlob as GitOid });
    files.sort((a, b) => compareGitPaths(a.path, b.path));
    tree = await repo.prepareIndex(operationId, files);
  } else {
    await repo.prepareIndexFromTree(operationId, j().targetTree);
    tree = j().targetTree;
  }
  const createdAt = clock.nowIso();
  const metadata: SnapshotMetadata = {
    schemaVersion: SNAPSHOT_METADATA_SCHEMA_VERSION,
    snapshotId: SnapshotId.parse(crypto.randomUUID()),
    kind: 'restore',
    createdAt,
    origin: rec().origin,
    operationId,
    ...(j().target.snapshotId ? { restoreOf: j().target.snapshotId as SnapshotId } : {}),
  };
  let commit: GitOid;
  try {
    commit = await repo.createCommit({
      tree,
      parents: [parent],
      message: formatCommitMessage(metadata),
      identity: ctx.identity,
      time: createdAt,
    });
  } catch (e) {
    await repo.discardPreparedIndex(operationId).catch(() => undefined);
    throw e;
  }
  const intent = {
    step: 'final' as const,
    ref: j().ref,
    expectedOld: parent,
    commit,
    tree,
    snapshotId: metadata.snapshotId,
  };
  move('publishing', { restoreTree: tree, publish: intent });
  await ctx.hooks.checkpoint?.('restore:publishing');
  try {
    await repo.publish({
      operationId,
      ref: j().ref,
      expectedOld: parent,
      commit,
      reflogMessage: 'draft-tide: restore',
      ...(ctx.options.lockWaitMs !== undefined ? { lockWaitMs: ctx.options.lockWaitMs } : {}),
    });
  } catch (e) {
    // The version is in history and only the index switch is left: recovery
    // completes it before the next change.
    if (e instanceof DtError && e.code === 'RECOVERY_REQUIRED') {
      state.rec = journal.note(state.rec, { ...j(), reason: 'index-switch', error: operationError(e) });
      throw e;
    }
    const reason = e instanceof DtError && e.code === 'HISTORY_CHANGED' ? 'history-changed' : 'not-recorded';
    move('recovery-required', { reason, error: operationError(e) });
    throw new DtError(
      'RECOVERY_REQUIRED',
      "the files were restored but the restore version couldn't be recorded; finish it from the recovery screen",
      { operationId, reason, cause: e instanceof DtError ? e.code : 'INTERNAL_ERROR' },
    );
  }
  const restored = { commit, snapshotId: metadata.snapshotId };
  move('committed', { restored, publish: null, reason: null, error: null });
  move('completed');
  const files = ctx.store.listOperationFiles(operationId);
  return {
    projectId: rec().projectId as ProjectId,
    operationId,
    target: j().target,
    protection: j().protection,
    restored,
    written: files.filter((f) => f.after !== null).length,
    deleted: files.filter((f) => f.after === null).length,
  };
}
