import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  OperationId,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectId,
  STATUS_CHANGES_MAX,
  canonicalJson,
  isSafeRelativePath,
  parseProjectConfig,
  serializeProjectConfig,
  type BindingState,
  type ErrorCode,
  type ExistingConfig,
  type FileDiff,
  type FolderReview,
  type FolderState,
  type HistoryPage,
  type Origin,
  type ProjectBindResult,
  type ProjectConfig,
  type ProjectStatus,
  type ProjectSummary,
  type SaveJournal,
  type SavedSnapshot,
  type SettingsRestored,
  type SnapshotDiff,
} from '@draft-tide/contracts';
import {
  TEXT_DIFF_BUDGET,
  diffFileContent,
  diffTreeFiles,
  takeWithinBudget,
  type DiffSide,
  type TreeFileAt,
} from './compare.ts';
import type { ProjectContext, WriteRun } from './context.ts';
import { historyEntryOf, resolveVersionRef, versionInfoOf } from './history.ts';
import { canMove, operationError } from './journal.ts';
import type { GitTreeEntry, OperationRecord, ProjectConfigRead, ProjectGit } from './ports.ts';
import type { RecoveryService } from './recovery.ts';
import { readSmallBlob } from './restore.ts';
import { saveSnapshot } from './save.ts';
import { assertNoBlockers, assertSupportedEntries, reviewScope, type ScopeReview } from './scope.ts';
import { gitBlobId, sha256Hex } from './text.ts';
import { workingStatus } from './working.ts';

// The project use cases behind the catalog's project, snapshot and history
// operations (M1-04): review and connect a folder, read its status, save a
// version, list history and compare versions. Every channel reaches the same
// functions; who may call what is decided before (policy.ts). Saves are
// journaled and run recovery first (M1-05).

export interface ProjectService {
  review(root: string, signal?: AbortSignal): Promise<FolderReview>;
  bind(input: {
    root: string;
    name: string;
    entryFiles: string[];
    reviewToken: string;
    asNewProject?: boolean | undefined;
  }): Promise<ProjectBindResult>;
  status(projectId: ProjectId): Promise<ProjectStatus>;
  restoreSettings(projectId: ProjectId): Promise<SettingsRestored>;
  save(projectId: ProjectId, name: string | undefined, origin: Origin): Promise<SavedSnapshot>;
  history(projectId: ProjectId, page: { skip: number; limit: number }): Promise<HistoryPage>;
  diff(projectId: ProjectId, from: string, to: string): Promise<SnapshotDiff>;
  diffFile(projectId: ProjectId, from: string, to: string, path: string): Promise<FileDiff>;
}

// Connecting folders is serialized; saves of one project are serialized with
// each other and with a relink of that project.
const BINDINGS_GUARD = 'bindings';
const MAX_CHANGES_BYTES = 640 * 1024;
const MAX_DIFF_CHANGES = 5000;

function codeOf(e: unknown): ErrorCode | null {
  return e instanceof DtError ? e.code : null;
}

function folderName(root: string): string {
  return (
    root
      .split(/[\\/]/)
      .filter((s) => s !== '')
      .at(-1) ?? root
  ).slice(0, 200);
}

interface Reviewed {
  root: string;
  dto: FolderReview;
  scope: ScopeReview;
  configRead: ProjectConfigRead | null;
}

export function createProjectService(ctx: ProjectContext, recovery: RecoveryService): ProjectService {
  const { store, host, clock, guards, journal, requireProject, openBound, readableRepo, publish, lineIndex } = ctx;

  // ---- review and bind

  async function isProjectFolder(p: ProjectSummary): Promise<boolean> {
    try {
      if ((await host.canonicalRoot(p.root)) !== p.root) return false;
      return (await host.openWorkspace(p.root).readProjectConfig())?.config.projectId === p.projectId;
    } catch {
      return false;
    }
  }

  async function reviewFolder(rootInput: string, signal?: AbortSignal): Promise<Reviewed> {
    const root = await host.canonicalRoot(rootInput);
    const workspace = host.openWorkspace(root);
    let configRead: ProjectConfigRead | null = null;
    let config: ExistingConfig = { status: 'missing' };
    try {
      configRead = await workspace.readProjectConfig();
      if (configRead) {
        const { projectId, name, entryFiles } = configRead.config;
        config = { status: 'valid', projectId, name, entryFiles };
      }
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'CONFIG_INVALID') throw e;
      const reason = e.details['reason'];
      config = {
        status: 'invalid',
        reason: reason as Extract<ExistingConfig, { status: 'invalid' }>['reason'],
        details: e.details,
      };
    }

    const projectRepo = host.openRepo(root);
    const hasRepo = (await projectRepo.probe(signal)).hasRepo;
    const listing = hasRepo ? null : await host.openListingRepo(root);
    let scope: ScopeReview;
    try {
      scope = await reviewScope(listing?.repo ?? projectRepo, workspace, configRead?.config ?? null, signal);
    } finally {
      await listing?.dispose();
    }

    let binding: BindingState = { status: 'new' };
    const here = store.findProjectByRoot(root);
    if (here) binding = { status: 'bound-here', project: here };
    else if (configRead) {
      const elsewhere = store.getProject(configRead.config.projectId);
      if (elsewhere)
        binding = { status: 'bound-elsewhere', project: elsewhere, available: await isProjectFolder(elsewhere) };
    }
    const freeBytes = await workspace.projectSpace().then(
      (s) => Math.max(0, Math.floor(s.availableBytes)),
      () => null,
    );
    const reviewToken = await sha256Hex(
      canonicalJson({
        root,
        scope: scope.fingerprint,
        config: configRead?.oid ?? config.status,
        binding: binding.status === 'new' ? 'new' : `${binding.status}:${binding.project.projectId}`,
      }),
    );
    const { probe } = scope;
    const dto: FolderReview = {
      root,
      folderName: folderName(root),
      repo: { hasRepo: probe.hasRepo, branch: probe.branch, tip: probe.tip, warnings: probe.warnings },
      blockers: scope.blockers,
      scopeListed: !probe.blockers.some((b) => b.code === 'REPO_UNSUPPORTED'),
      included: scope.included,
      deleted: scope.deleted,
      unsupported: { count: scope.unsupported.count, entries: scope.unsupported.entries.slice(0, 100) },
      excluded: scope.excluded,
      excludedByDefaults: scope.excludedByDefaults,
      entryFiles: scope.entryFiles,
      entryCandidates: scope.entryCandidates,
      config,
      binding,
      suggestedName: (configRead?.config.name.trim() || folderName(root)).slice(0, 200),
      freeBytes,
      reviewToken,
    };
    return { root, dto, scope, configRead };
  }

  async function bind(input: Parameters<ProjectService['bind']>[0]): Promise<ProjectBindResult> {
    return guards.run(BINDINGS_GUARD, async () => {
      // The folder must still be what the user reviewed and confirmed.
      const reviewed = await reviewFolder(input.root);
      const { root, dto, scope, configRead } = reviewed;
      if (dto.reviewToken !== input.reviewToken) {
        throw new DtError('SCOPE_CHANGED', 'the folder changed since it was reviewed; review it again', {});
      }
      if (dto.binding.status === 'bound-here') {
        return { project: dto.binding.project, initialized: false, configWritten: false, relinked: false };
      }
      // Everything that would stop the first save stops connecting, before
      // anything is written.
      if (dto.config.status === 'invalid') {
        throw new DtError(
          'CONFIG_INVALID',
          ".drafttide.json can't be used; fix or remove it first",
          dto.config.details,
        );
      }
      assertNoBlockers(dto.blockers);
      assertSupportedEntries(scope.unsupported.entries);
      const included = new Set(scope.includedPaths);
      const entryFiles = [...new Set(input.entryFiles)];
      for (const e of entryFiles) {
        if (!included.has(e)) {
          throw new DtError('INVALID_ARGUMENT', 'an entry page must be a file that is saved', {
            reason: 'entry-not-included',
          });
        }
      }

      let projectId: ProjectId;
      let relinked = false;
      if (input.asNewProject === true || !configRead) {
        projectId = ProjectId.parse(crypto.randomUUID());
      } else {
        projectId = configRead.config.projectId;
        if (dto.binding.status === 'bound-elsewhere') {
          if (dto.binding.available) {
            throw new DtError(
              'PROJECT_ALREADY_BOUND',
              "this folder's settings name a project that is connected to another folder",
              { projectId, root: dto.binding.project.root },
            );
          }
          relinked = true;
        }
      }
      const name = input.name.trim() || dto.suggestedName;
      const config: ProjectConfig = {
        schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
        projectId,
        name,
        entryFiles,
        excludeDirNames: configRead?.config.excludeDirNames ?? [],
        excludeFilePatterns: configRead?.config.excludeFilePatterns ?? [],
      };
      const bytes = new TextEncoder().encode(serializeProjectConfig(config));

      return guards.run(projectId, async () => {
        let initialized = false;
        if (!dto.repo.hasRepo) {
          await host.openRepo(root).init();
          initialized = true;
        }
        const configWritten = configRead?.oid !== (await gitBlobId(bytes));
        if (configWritten) await host.openWorkspace(root).writeProjectConfig(bytes, configRead?.oid ?? null);
        let project: ProjectSummary;
        if (relinked) {
          store.updateProject(projectId, { root, name });
          project = requireProject(projectId);
        } else {
          project = { projectId, name, root, boundAt: clock.nowIso() };
          store.insertProject(project);
        }
        ctx.dropCaches(projectId);
        publish({ name: 'project.changed', projectId, reason: 'bound' });
        return { project, initialized, configWritten, relinked };
      });
    });
  }

  // ---- status

  async function status(projectId: ProjectId): Promise<ProjectStatus> {
    const p = requireProject(projectId);
    const result: ProjectStatus = {
      project: p,
      folder: 'available',
      configProblem: null,
      name: p.name,
      entryFiles: [],
      branch: null,
      tip: null,
      blockers: [],
      warnings: [],
      recoveryRequired: false,
      activeOperation: ctx.activeOperation(projectId),
      changes: null,
      unsupported: { count: 0, entries: [] },
      checkedAt: clock.nowIso(),
    };
    let opened: Awaited<ReturnType<typeof openBound>>;
    try {
      opened = await openBound(p);
    } catch (e) {
      if (codeOf(e) === 'LOCAL_ROOT_UNAVAILABLE') return { ...result, folder: 'missing' };
      throw e;
    }
    const { repo, workspace } = opened;
    const probe = await repo.probe();
    if (!probe.hasRepo) return { ...result, folder: 'repo-missing', blockers: probe.blockers };
    result.blockers = probe.blockers;
    result.warnings = probe.warnings;
    result.branch = probe.branch;

    let config: ProjectConfig | null = null;
    let folder: FolderState = 'available';
    try {
      const read = await workspace.readProjectConfig();
      if (!read) folder = 'config-missing';
      else if (read.config.projectId !== projectId) folder = 'project-mismatch';
      else config = read.config;
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'CONFIG_INVALID') throw e;
      folder = 'config-invalid';
      const reason = e.details['reason'] as NonNullable<ProjectStatus['configProblem']>['reason'];
      result.configProblem = { reason, details: e.details };
    }
    result.folder = folder;
    if (config) {
      result.name = config.name || p.name;
      result.entryFiles = config.entryFiles;
    }
    if (probe.headRef === null) return result;

    result.recoveryRequired = recovery.pending(projectId, await repo.indexLock());
    let tipFiles: GitTreeEntry[] = [];
    if (probe.tip !== null) {
      const index = await lineIndex(projectId, repo, probe.tip);
      const [commit] = await repo.readCommits([probe.tip]);
      if (commit) {
        result.tip = historyEntryOf(commit, index);
        if (config) tipFiles = (await repo.listTree(commit.tree)).entries;
      }
    }
    if (!config || probe.blockers.some((b) => b.code === 'REPO_UNSUPPORTED')) return result;

    const working = await workingStatus({
      repo,
      workspace,
      probe,
      config,
      tipFiles,
      cache: ctx.hashCache(projectId),
      nowMs: Date.parse(clock.nowIso()),
    });
    const { taken } = takeWithinBudget(working.changes.slice(0, STATUS_CHANGES_MAX), MAX_CHANGES_BYTES);
    result.changes = { ...working.counts, entries: taken };
    result.blockers = [...probe.blockers, ...working.blockers];
    result.unsupported = { count: working.unsupported.length, entries: working.unsupported.slice(0, 100) };
    return result;
  }

  // ---- save

  async function save(projectId: ProjectId, name: string | undefined, origin: Origin): Promise<SavedSnapshot> {
    const p = requireProject(projectId);
    const operationId = OperationId.parse(crypto.randomUUID());
    const settled = (
      outcome: 'completed' | 'no-changes' | 'failed' | 'cancelled' | 'recovery-required',
      code: ErrorCode | null,
    ) =>
      publish({
        name: 'operation.settled',
        operationId,
        projectId,
        operation: 'snapshot.create',
        origin,
        outcome,
        code,
      });
    const op = { operationId, activity: 'saving' as const, origin };
    const onProgress = ctx.progressReporter({ ...op, projectId }, 'snapshot.create');
    const empty: SaveJournal = { kind: 'save', publish: null, snapshot: null, error: null };
    const state: { rec: OperationRecord } = {
      rec: journal.begin({ operationId, projectId, kind: 'save', origin, state: 'confirmed', journal: empty }),
    };
    const j = () => state.rec.journal as SaveJournal;

    async function underGuard(run: WriteRun) {
      run.signal.throwIfAborted();
      state.rec = journal.move(state.rec, 'preflight');
      const { repo, workspace } = await openBound(p);
      await recovery.beforeWrite(p, repo);
      const configName = await workspace.readProjectConfig().then(
        (r) => (r?.config.projectId === projectId ? r.config.name : null),
        () => null,
      );
      const result = await saveSnapshot({
        repo,
        workspace,
        staging: await host.createStaging(projectId, operationId),
        projectId,
        operationId,
        origin,
        name,
        identity: ctx.identity,
        clock,
        signal: run.signal,
        onProgress,
        onPublish: async (intent) => {
          // Publishing is never interrupted by a cancel.
          run.pastPointOfNoReturn();
          state.rec = journal.move(state.rec, 'publishing', { ...j(), publish: intent });
          await ctx.hooks.checkpoint?.('save:publishing');
        },
        ...(ctx.options.retryDelayMs ? { retryDelayMs: ctx.options.retryDelayMs } : {}),
        ...(ctx.options.lockWaitMs !== undefined ? { lockWaitMs: ctx.options.lockWaitMs } : {}),
      });
      await ctx.hooks.checkpoint?.('save:published');
      const snapshot = { commit: result.commit, snapshotId: result.snapshotId };
      state.rec = journal.move(state.rec, 'committed', { ...j(), publish: null, snapshot });
      state.rec = journal.move(state.rec, 'completed');
      // The list shows the name the settings carry.
      if (configName && configName !== p.name) store.updateProject(projectId, { name: configName });
      return result;
    }

    // Under the guard: what a failure leaves in the journal. A publish whose
    // ref moved keeps its row (recovery switches the index before the next
    // change), and so does a save whose version was recorded (committed).
    const recordFailure = (e: unknown) => {
      const code = codeOf(e) ?? 'INTERNAL_ERROR';
      if (state.rec.state === 'publishing' && code === 'RECOVERY_REQUIRED') return;
      const to = code === 'CANCELLED' ? 'cancelled' : 'failed';
      if (canMove(state.rec.state, to)) {
        state.rec = journal.move(state.rec, to, { ...j(), publish: null, error: operationError(e) });
      }
    };

    try {
      const saved = await ctx.runWrite(projectId, op, async (run) => {
        try {
          return await underGuard(run);
        } catch (e) {
          recordFailure(e);
          throw e;
        }
      });
      settled('completed', null);
      publish({ name: 'project.changed', projectId, reason: 'saved' });
      const trimmed = name?.trim();
      return {
        projectId,
        snapshotId: saved.snapshotId,
        kind: saved.kind,
        name: trimmed ? trimmed : null,
        createdAt: saved.createdAt,
        origin,
        commit: saved.commit,
        tree: saved.tree,
        parent: saved.parent,
        branch: saved.branch,
        files: saved.files,
        bytes: saved.bytes,
        newObjects: saved.newObjects,
        newBytes: saved.newBytes,
      };
    } catch (e) {
      const code = codeOf(e) ?? 'INTERNAL_ERROR';
      if (state.rec.state === 'publishing' && code === 'RECOVERY_REQUIRED') {
        settled('recovery-required', code);
        publish({ name: 'project.changed', projectId, reason: 'saved' });
        publish({ name: 'operations.changed' });
      } else {
        settled(code === 'NO_CHANGES' ? 'no-changes' : code === 'CANCELLED' ? 'cancelled' : 'failed', code);
      }
      throw e;
    }
  }

  // ---- putting a deleted settings file back (M1-05)
  //
  // `.drafttide.json` defines the scope, so a folder without it can't be
  // saved or restored. Its copy in the newest commit comes back, only while
  // the file is absent: a file that is there, even a broken one, is the
  // user's to fix, never replaced.
  async function restoreSettings(projectId: ProjectId): Promise<SettingsRestored> {
    const p = requireProject(projectId);
    return guards.run(projectId, async () => {
      const { repo, workspace } = await openBound(p);
      const probe = await readableRepo(repo);
      await recovery.beforeWrite(p, repo);
      if (probe.tip === null) throw new DtError('SNAPSHOT_NOT_FOUND', 'the project has no versions yet', {});
      const present = await workspace.readProjectConfig().then(
        (r) => r !== null,
        (e: unknown) => {
          if (e instanceof DtError && e.code === 'CONFIG_INVALID') return true;
          throw e;
        },
      );
      if (present) {
        throw new DtError(
          'INVALID_ARGUMENT',
          `${PROJECT_CONFIG_FILE} is in the folder; Draft Tide doesn't replace it`,
          {
            reason: 'settings-present',
          },
        );
      }
      const [tip] = await repo.readCommits([probe.tip]);
      const entry = tip ? await repo.lookupPath(tip.tree, PROJECT_CONFIG_FILE) : null;
      const bytes = entry?.type === 'blob' ? await readSmallBlob(repo, entry.oid, MAX_PROJECT_CONFIG_BYTES) : null;
      if (!bytes) {
        throw new DtError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE}: the newest version has none to put back`, {
          reason: 'missing',
        });
      }
      if (parseProjectConfig(bytes).projectId !== projectId) {
        throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the newest version's settings name another project", {
          reason: 'project-mismatch',
        });
      }
      // Compare-and-swap on "absent": a file that appeared meanwhile is
      // SCOPE_CHANGED and stays as it is.
      await workspace.writeProjectConfig(bytes, null);
      ctx.dropCaches(projectId);
      publish({ name: 'project.changed', projectId, reason: 'restored' });
      return { projectId, from: probe.tip };
    });
  }

  // ---- history and comparison

  async function history(projectId: ProjectId, page: { skip: number; limit: number }): Promise<HistoryPage> {
    const p = requireProject(projectId);
    const { repo } = await openBound(p);
    const probe = await readableRepo(repo);
    if (probe.tip === null) {
      return { branch: probe.branch, tip: null, total: 0, versions: 0, entries: [], nextSkip: null };
    }
    const index = await lineIndex(projectId, repo, probe.tip);
    const oids = index.commits.slice(page.skip, page.skip + page.limit);
    const commits = await repo.readCommits(oids);
    const next = page.skip + oids.length;
    return {
      branch: probe.branch,
      tip: probe.tip,
      total: index.commits.length,
      versions: index.seqOf.size,
      entries: commits.map((c) => historyEntryOf(c, index)),
      nextSkip: next < index.commits.length ? next : null,
    };
  }

  async function versionsOf(projectId: ProjectId, from: string, to: string) {
    const p = requireProject(projectId);
    const { repo } = await openBound(p);
    const probe = await readableRepo(repo);
    if (probe.tip === null) throw new DtError('SNAPSHOT_NOT_FOUND', 'the project has no versions yet', { ref: from });
    const index = await lineIndex(projectId, repo, probe.tip);
    const [a, b] = await repo.readCommits([resolveVersionRef(index, from), resolveVersionRef(index, to)]);
    if (!a || !b) throw new DtError('GIT_FAILED', 'a version could not be read');
    return { repo, index, a, b };
  }

  const treeFiles = (entries: readonly GitTreeEntry[]): TreeFileAt[] =>
    entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid, size: e.size }));

  async function diff(projectId: ProjectId, from: string, to: string): Promise<SnapshotDiff> {
    const { repo, index, a, b } = await versionsOf(projectId, from, to);
    const [left, right] = await Promise.all([repo.listTree(a.tree), repo.listTree(b.tree)]);
    const { changes, summary } = diffTreeFiles(treeFiles(left.entries), treeFiles(right.entries));
    const { taken, truncated } = takeWithinBudget(changes.slice(0, MAX_DIFF_CHANGES), MAX_CHANGES_BYTES);
    return {
      from: versionInfoOf(a, index),
      to: versionInfoOf(b, index),
      summary,
      changes: taken,
      truncated: truncated || changes.length > MAX_DIFF_CHANGES,
    };
  }

  async function readSide(repo: ProjectGit, entry: GitTreeEntry | null): Promise<DiffSide | null> {
    if (!entry) return null;
    const file = { mode: entry.mode, oid: entry.oid, size: entry.size };
    const isFile = entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
    if (!isFile || entry.size === null || entry.size > TEXT_DIFF_BUDGET.maxBytesPerSide) return { file, bytes: null };
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of repo.streamBlob(entry.oid)) {
      chunks.push(chunk);
      length += chunk.byteLength;
      if (length > TEXT_DIFF_BUDGET.maxBytesPerSide) return { file, bytes: null };
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { file, bytes };
  }

  async function diffFile(projectId: ProjectId, from: string, to: string, path: string): Promise<FileDiff> {
    if (!isSafeRelativePath(path)) {
      throw new DtError('INVALID_ARGUMENT', 'not a path inside the project', { reason: 'invalid-path' });
    }
    const { repo, a, b } = await versionsOf(projectId, from, to);
    const [left, right] = await Promise.all([repo.lookupPath(a.tree, path), repo.lookupPath(b.tree, path)]);
    if (!left && !right) {
      throw new DtError('INVALID_ARGUMENT', 'the file is in neither version', { reason: 'path-not-found' });
    }
    const [before, after] = await Promise.all([readSide(repo, left), readSide(repo, right)]);
    return diffFileContent(path, before, after);
  }

  return {
    review: async (root, signal) => (await reviewFolder(root, signal)).dto,
    bind,
    status,
    restoreSettings,
    save,
    history,
    diff,
    diffFile,
  };
}
