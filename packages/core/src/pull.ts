import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  OperationId,
  PROJECT_CONFIG_FILE,
  PlanId,
  parseProjectConfig,
  type CommitRef,
  type ErrorCode,
  type OpenJournal,
  type Origin,
  type ProjectId,
  type ProjectSummary,
  type PublishIntent,
  type PullJournal,
  type PullPlanRecord,
  type RestoreChange,
  type SyncProgress,
  type SyncPullPlan,
  type SyncPullResult,
} from '@draft-tide/contracts';
import { SPACE_MARGIN_BYTES, captureScope } from './capture.ts';
import { diffTreeFiles, takeWithinBudget, type TreeFileAt } from './compare.ts';
import type { ProjectContext, WriteRun } from './context.ts';
import { buildLineIndex, versionInfoOf } from './history.ts';
import { operationError } from './journal.ts';
import { compareGitPaths } from './paths.ts';
import type { GitOid, OperationFile, OperationRecord, ProjectGit } from './ports.ts';
import {
  accessCheck,
  currentConfig,
  fileStates,
  findCollisions,
  plannedChanges,
  readLiveFolder,
  readSmallBlob,
  restorableFiles,
  restoreFingerprint,
  stale,
  transition,
  usablePlan,
  type RecoveryGate,
  type RestoreFile,
} from './restore.ts';
import { probeForWrite } from './save.ts';
import { assertNoBlockers } from './scope.ts';
import { relate, repoOf, type SyncService } from './sync.ts';

// Getting the remote's newer versions (M1 plan §10.4): fast-forward only.
//
// plan   fetches, classifies (equal, ahead, behind, diverged), and for behind
//        says what the fast-forward would write and delete, against the folder
//        as it is. Unsaved changes refuse it (UNSAVED_CHANGES: save first), so
//        nothing unsaved is ever overwritten and no protection version is
//        needed.
// apply  under the write guard, like a restore: the folder is captured,
//        checked against the plan, the files that differ between the tip's
//        tree and the remote's are written one at a time (each only if it
//        still holds what the capture saw), read back, and then the branch
//        moves to the remote commit lock-first. No new commit.
//
// Diverged history changes nothing on either side (REMOTE_DIVERGED). After
// the first file the pull finishes or stops for recovery (finish while the
// branch is still at the base, or rollback).

export interface PullService {
  plan(projectId: ProjectId): Promise<SyncPullPlan>;
  apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<SyncPullResult>;
}

const MAX_CHANGES_BYTES = 640 * 1024;
const MAX_CHANGES = 5000;
const MAX_COLLISIONS = 100;
const NO_CONFLICTS = { count: 0, sample: [] as string[] };

const asTree = (f: { path: string; mode: string; oid: GitOid; size: number | null }): TreeFileAt => ({
  path: f.path,
  mode: f.mode,
  oid: f.oid,
  size: f.size,
});

// Whether a version's `.drafttide.json` names this project. A pull that
// brings settings for another project, or none, would cut the folder off
// from it.
async function settingsNameProject(repo: ProjectGit, files: readonly RestoreFile[], projectId: ProjectId) {
  const theirs = files.find((f) => f.path === PROJECT_CONFIG_FILE);
  if (!theirs) return false;
  const bytes = await readSmallBlob(repo, theirs.oid, MAX_PROJECT_CONFIG_BYTES);
  if (bytes === null) return false;
  try {
    return parseProjectConfig(bytes).projectId === projectId;
  } catch (e) {
    if (e instanceof DtError && e.code === 'CONFIG_INVALID') return false;
    throw e;
  }
}

function unsavedError(count: number): DtError {
  return new DtError('UNSAVED_CHANGES', 'the folder has unsaved changes; save a version first, then get the updates', {
    count,
  });
}

// Moves the branch to the remote commit lock-first (M1 plan §9.3.1): from the
// pull's base, or creating it for an open. Shared with recovery's finish.
export async function recordFastForward(
  ctx: ProjectContext,
  state: { rec: OperationRecord },
  args: { repo: ProjectGit; report?: (progress: SyncProgress) => void },
): Promise<void> {
  const { journal } = ctx;
  const { repo } = args;
  const j = () => state.rec.journal as PullJournal | OpenJournal;
  const move = (
    to: OperationRecord['state'],
    patch: { publish?: PublishIntent | null; reason?: PullJournal['reason']; error?: PullJournal['error'] } = {},
  ) => {
    state.rec = journal.move(state.rec, to, { ...j(), ...patch });
  };
  const operationId = state.rec.operationId;
  const kind = j().kind;
  const expectedOld = kind === 'pull' ? (j() as PullJournal).base.commit : null;
  args.report?.({ stage: 'publish', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
  await repo.prepareIndexFromTree(operationId, j().targetTree);
  const intent = {
    step: 'final' as const,
    ref: j().ref,
    expectedOld,
    commit: j().target.commit,
    tree: j().targetTree,
    snapshotId: j().target.snapshotId,
  };
  move('publishing', { publish: intent });
  await ctx.hooks.checkpoint?.(`${kind}:publishing`);
  try {
    await repo.publish({
      operationId,
      ref: j().ref,
      expectedOld,
      commit: j().target.commit,
      reflogMessage: `draft-tide: ${kind}`,
      ...(ctx.options.lockWaitMs !== undefined ? { lockWaitMs: ctx.options.lockWaitMs } : {}),
    });
  } catch (e) {
    if (e instanceof DtError && e.code === 'RECOVERY_REQUIRED') {
      state.rec = journal.note(state.rec, { ...j(), reason: 'index-switch', error: operationError(e) });
      throw e;
    }
    const reason = e instanceof DtError && e.code === 'HISTORY_CHANGED' ? 'history-changed' : 'not-recorded';
    move('recovery-required', { reason, error: operationError(e) });
    throw new DtError(
      'RECOVERY_REQUIRED',
      "the files were written but the branch couldn't be moved; finish it from the recovery screen",
      { operationId, reason, cause: e instanceof DtError ? e.code : 'INTERNAL_ERROR' },
    );
  }
  move('committed', { publish: null, reason: null, error: null });
  move('completed');
}

export function createPullService(ctx: ProjectContext, recovery: RecoveryGate, sync: SyncService): PullService {
  const { store, clock, journal } = ctx;

  async function plan(projectId: ProjectId): Promise<SyncPullPlan> {
    const p = ctx.requireProject(projectId);
    const stored = store.getRemote(projectId);
    if (!stored) {
      throw new DtError('INVALID_ARGUMENT', 'this project is not connected to a GitHub repository', {
        reason: 'not-connected',
      });
    }
    const { root, repo, workspace } = await ctx.openBound(p);
    const probe = await ctx.readableRepo(repo);
    assertNoBlockers(probe.blockers);
    if (probe.branch !== stored.remote.branch) {
      throw new DtError(
        'INVALID_ARGUMENT',
        `switch the folder back to branch ${stored.remote.branch} to get its updates`,
        { reason: 'branch-changed', branch: stored.remote.branch },
      );
    }
    const remoteTip = await sync.fetch(projectId);
    const tip = probe.tip;
    const r = await relate(repo, tip, remoteTip);
    const relation: SyncPullPlan['relation'] =
      r === 'empty' ? 'no-remote-branch' : r === 'same' ? 'equal' : r === 'unrelated' ? 'diverged' : r;

    const localIndex = tip !== null ? await ctx.lineIndex(projectId, repo, tip) : null;
    const [base] = tip !== null ? await repo.readCommits([tip]) : [];
    const baseInfo = base && localIndex ? versionInfoOf(base, localIndex) : null;
    const createdAt = clock.nowIso();
    const planId = PlanId.parse(crypto.randomUUID());
    const expiresAt = new Date(Date.parse(createdAt) + ctx.planTtlMs).toISOString();
    const empty = {
      summary: { overwrite: 0, add: 0, delete: 0, unchanged: 0 },
      changes: [],
      truncated: false,
      unsavedChanges: 0,
      collisions: { count: 0, entries: [] },
      space: { requiredBytes: 0, availableBytes: null },
    };

    if (relation !== 'behind' || remoteTip === null || base === undefined || tip === null) {
      // Nothing to apply. The stored plan answers NO_CHANGES or
      // REMOTE_DIVERGED if applied anyway.
      if (tip !== null && base) {
        const record: PullPlanRecord = {
          kind: 'pull',
          ref: probe.headRef,
          remote: repoOf(stored.remote),
          relation,
          base: { commit: tip, snapshotId: baseInfo?.snapshotId ?? null },
          target: { commit: tip, snapshotId: baseInfo?.snapshotId ?? null },
          targetTree: base.tree,
        };
        store.insertPlan({ planId, projectId, createdAt, expiresAt, fingerprint: '', record, consumedBy: null });
      }
      const divergedReason = r === 'unrelated' ? 'unrelated-history' : 'diverged';
      return {
        planId,
        projectId,
        createdAt,
        expiresAt,
        branch: stored.remote.branch,
        relation,
        base: baseInfo,
        target: null,
        incoming: 0,
        ...empty,
        blocked: relation === 'diverged' ? { code: 'REMOTE_DIVERGED', reason: divergedReason } : null,
        noop: relation !== 'diverged',
      };
    }

    // Behind: what the fast-forward writes.
    const [target] = await repo.readCommits([remoteTip]);
    if (!target) throw new DtError('GIT_FAILED', 'the fetched version could not be read');
    const remoteIndex = await buildLineIndex(repo, remoteTip);
    const targetInfo = versionInfoOf(target, remoteIndex);
    const incoming = (await repo.commitsBetween(remoteTip, [tip])).length;
    let unsupported = false;
    let targetFiles: RestoreFile[] = [];
    try {
      targetFiles = restorableFiles(await repo.listTree(target.tree));
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'UNSUPPORTED_ENTRY') throw e;
      unsupported = true;
    }
    const otherSettings = !unsupported && !(await settingsNameProject(repo, targetFiles, projectId));
    const config = await currentConfig(workspace, projectId);
    const live = await readLiveFolder(ctx, projectId, repo, workspace, probe, config.config);
    const tipFiles = (await repo.listTree(base.tree)).entries.filter((e) => e.mode === '100644' || e.mode === '100755');
    const unsaved = diffTreeFiles(tipFiles.map(asTree), live.map(asTree)).summary.total;
    const changes = plannedChanges(live, targetFiles);
    const collisions = unsupported ? [] : await findCollisions(workspace, changes);
    const requiredBytes = changes.writes.reduce((n, w) => n + w.size, 0);
    const availableBytes = await workspace.projectSpace().then(
      (s) => Math.max(0, Math.floor(s.availableBytes)),
      () => null,
    );
    // The first reason applying would refuse, in the order apply checks.
    const reasons: [boolean, ErrorCode, string | null][] = [
      [await recovery.needsDecision(p, repo), 'RECOVERY_REQUIRED', null],
      [unsaved > 0, 'UNSAVED_CHANGES', null],
      [unsupported, 'UNSUPPORTED_ENTRY', 'version-not-restorable'],
      [otherSettings, 'CONFIG_INVALID', 'remote-settings'],
      [collisions.length > 0, 'UNTRACKED_FILES', null],
      [availableBytes !== null && availableBytes < requiredBytes + SPACE_MARGIN_BYTES, 'INSUFFICIENT_DISK_SPACE', null],
    ];
    const first = reasons.find(([hit]) => hit);
    const blocked: SyncPullPlan['blocked'] = first ? { code: first[1], reason: first[2] } : null;
    const fingerprint = await restoreFingerprint({
      root,
      ref: probe.headRef,
      tip,
      target: remoteTip,
      keptSettings: null,
      live,
      collisions,
    });
    const record: PullPlanRecord = {
      kind: 'pull',
      ref: probe.headRef,
      remote: repoOf(stored.remote),
      relation: 'behind',
      base: { commit: tip, snapshotId: baseInfo?.snapshotId ?? null },
      target: { commit: remoteTip, snapshotId: targetInfo.snapshotId },
      targetTree: target.tree,
    };
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
      branch: stored.remote.branch,
      relation,
      base: baseInfo,
      target: targetInfo,
      incoming,
      summary: {
        overwrite: changes.writes.filter((w) => w.before !== null).length,
        add: changes.writes.filter((w) => w.before === null).length,
        delete: changes.deletes.length,
        unchanged: changes.unchanged,
      },
      changes: taken,
      truncated: truncated || listed.length > MAX_CHANGES,
      unsavedChanges: unsaved,
      collisions: { count: collisions.length, entries: collisions.slice(0, MAX_COLLISIONS) },
      space: { requiredBytes, availableBytes },
      blocked,
      noop: false,
    };
  }

  async function apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<SyncPullResult> {
    const p = ctx.requireProject(projectId);
    const stored = usablePlan(ctx, projectId, planId, 'pull');
    const record = stored.record as PullPlanRecord;
    if (record.relation === 'diverged') {
      throw new DtError('REMOTE_DIVERGED', 'you and GitHub both have new versions; nothing was changed', {
        reason: 'diverged',
      });
    }
    if (record.relation !== 'behind') throw new DtError('NO_CHANGES', 'there are no newer versions on GitHub', {});
    const operationId = OperationId.parse(crypto.randomUUID());
    const begun: OperationRecord = {
      operationId,
      projectId,
      kind: 'pull',
      origin,
      state: 'confirmed',
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
      acknowledged: false,
      journal: {
        kind: 'pull',
        planId,
        ref: record.ref,
        remote: record.remote,
        base: record.base,
        target: record.target,
        targetTree: record.targetTree,
        publish: null,
        reason: null,
        conflicts: NO_CONFLICTS,
        error: null,
      },
    };
    if (!store.consumePlan(planId, operationId, begun.createdAt, begun)) {
      throw stale('used', 'this plan was already applied; make a new one');
    }
    const report = ctx.progressReporter({ operationId, origin, projectId }, 'sync.pullApply');
    report({ stage: 'check', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    const settled = (outcome: 'completed' | 'failed' | 'cancelled' | 'recovery-required', e?: unknown) =>
      ctx.publish({
        name: 'operation.settled',
        operationId,
        projectId,
        operation: 'sync.pullApply',
        origin,
        outcome,
        code: e === undefined ? null : operationError(e).code,
      });
    const state = { rec: begun };
    try {
      const result = await ctx.runWrite(projectId, { operationId, activity: 'pulling', origin }, async (run) => {
        try {
          run.signal.throwIfAborted();
          return await applyPull(state, p, stored.fingerprint, origin, run, report);
        } catch (caught) {
          throw settleFailure(state, caught);
        }
      });
      settled('completed');
      sync.recordFetched(projectId, record.target.commit);
      ctx.publish({ name: 'project.changed', projectId, reason: 'pulled' });
      if (origin !== 'gui') ctx.publish({ name: 'operations.changed' });
      return result;
    } catch (e) {
      const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
      const outcome =
        state.rec.state === 'recovery-required' || state.rec.state === 'publishing'
          ? 'recovery-required'
          : code === 'CANCELLED'
            ? 'cancelled'
            : 'failed';
      settled(outcome, e);
      if (outcome === 'recovery-required') ctx.publish({ name: 'operations.changed' });
      throw e;
    } finally {
      ctx.dropCaches(projectId);
    }
  }

  function settleFailure(state: { rec: OperationRecord }, caught: unknown): unknown {
    const rec = state.rec;
    const j = rec.journal as PullJournal;
    if (rec.state === 'applying' || rec.state === 'verified') {
      const reason = rec.state === 'verified' ? 'not-recorded' : 'write-failed';
      state.rec = journal.move(rec, 'recovery-required', { ...j, reason, error: operationError(caught) });
      return new DtError(
        'RECOVERY_REQUIRED',
        'getting the updates stopped part-way; nothing was lost. Finish it or put the files back from the recovery screen',
        { operationId: rec.operationId, reason },
      );
    }
    if (rec.state === 'confirmed' || rec.state === 'preflight') {
      const cancelled = caught instanceof DtError && caught.code === 'CANCELLED';
      state.rec = journal.move(rec, cancelled ? 'cancelled' : 'failed', { ...j, error: operationError(caught) });
    }
    return caught;
  }

  async function applyPull(
    state: { rec: OperationRecord },
    p: ProjectSummary,
    fingerprint: string,
    origin: Origin,
    run: WriteRun,
    report: (progress: SyncProgress) => void,
  ): Promise<SyncPullResult> {
    const projectId = p.projectId;
    const operationId = state.rec.operationId;
    const { signal } = run;
    const checkAccess = accessCheck(ctx, origin);
    const j = () => state.rec.journal as PullJournal;
    const move = (to: OperationRecord['state'], patch: Partial<PullJournal> = {}) => {
      state.rec = journal.move(state.rec, to, { ...j(), ...patch });
    };
    const fail = (to: 'failed' | 'cancelled', e: unknown) => move(to, { error: operationError(e) });

    move('preflight');
    await ctx.hooks.checkpoint?.('pull:preflight');
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
      if (probe.headRef !== j().ref || probe.tip !== j().base.commit) {
        throw stale('history-changed', 'the history changed since the plan was made; check for updates again');
      }
      if ((await repo.indexLock()).held) {
        throw new DtError('LOCKED', 'another Git program is using this repository right now; nothing was changed', {
          lock: 'index',
        });
      }
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
      const [base, target] = await repo.readCommits([j().base.commit, j().target.commit]);
      if (!base || !target) throw stale('changed', 'a version could not be read; check for updates again');
      const tipFiles = (await repo.listTree(base.tree)).entries.filter(
        (e) => e.mode === '100644' || e.mode === '100755',
      );
      const unsaved = diffTreeFiles(tipFiles.map(asTree), capture.files.map(asTree)).summary.total;
      if (unsaved > 0) throw unsavedError(unsaved);
      const targetFiles = restorableFiles(await repo.listTree(target.tree));
      if (!(await settingsNameProject(repo, targetFiles, projectId))) {
        throw new DtError(
          'CONFIG_INVALID',
          "GitHub's newest version has no settings for this project, or settings for another; nothing was changed",
          { reason: 'remote-settings' },
        );
      }
      const changes = plannedChanges(capture.files, targetFiles);
      const collisions = await findCollisions(workspace, changes);
      const now = await restoreFingerprint({
        root,
        ref: probe.headRef,
        tip: j().base.commit,
        target: j().target.commit,
        keptSettings: null,
        live: capture.files,
        collisions,
      });
      if (now !== fingerprint) throw stale('changed', 'files changed since the plan was made; check for updates again');
      if (collisions.length > 0) {
        throw new DtError(
          'UNTRACKED_FILES',
          'files that no version holds are in the way; move them, then check for updates again',
          { count: collisions.length },
        );
      }
      const space = await workspace.projectSpace();
      const required = changes.writes.reduce((n, w) => n + w.size, 0) + SPACE_MARGIN_BYTES;
      if (space.availableBytes < required) {
        throw new DtError('INSUFFICIENT_DISK_SPACE', 'not enough free disk space to get the updates', {
          volume: 'project',
          requiredBytes: required,
          availableBytes: space.availableBytes,
        });
      }
      files = [
        ...changes.deletes.map((d) => ({ path: d.path, before: d.before, after: null })),
        ...changes.writes.map((w) => ({ path: w.path, before: w.before, after: w.after })),
      ].map((f, seq): OperationFile => ({ ...f, seq, done: false }));
      for (const w of changes.writes) sizes.set(w.path, w.size);
      store.insertOperationFiles(operationId, files);
      move('staged');
      await ctx.hooks.checkpoint?.('pull:staged');
      await staging.remove().catch(() => undefined);
      staging = null;
      if ((await repo.indexLock()).held) {
        throw new DtError('LOCKED', 'another Git program is using this repository right now; nothing was changed', {
          lock: 'index',
        });
      }
      checkAccess();
      signal.throwIfAborted();
      run.pastPointOfNoReturn();
    } catch (e) {
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
    const needRecovery = (reason: PullJournal['reason'], e: unknown, conflicts: string[] = []) => {
      move('recovery-required', {
        reason,
        error: operationError(e),
        conflicts: { count: conflicts.length, sample: conflicts.slice(0, 50) },
      });
      return new DtError(
        'RECOVERY_REQUIRED',
        'getting the updates stopped part-way; nothing was lost. Finish it or put the files back from the recovery screen',
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
        const e = stale('external-change', 'a file changed while the updates were written; it was left as it is');
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
      await ctx.hooks.checkpoint?.('pull:file', { path: f.path, index: written + deleted });
    }
    report({ stage: 'verify', filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: 0 });
    const states = await fileStates(workspace, files, trustExec);
    const off = files.filter((_, i) => states[i] !== 'after').map((f) => f.path);
    if (off.length > 0) {
      throw needRecovery('verify-failed', new DtError('PLAN_STALE', 'files changed after they were written'), off);
    }
    move('verified');
    await ctx.hooks.checkpoint?.('pull:verified');
    await recordFastForward(ctx, state, { repo, report });
    const from: CommitRef = j().base;
    return { projectId, operationId, from, to: j().target, written, deleted };
  }

  return { plan, apply };
}
