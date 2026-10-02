import {
  DtError,
  OperationId,
  PlanId,
  canonicalJson,
  readCommitMetadata,
  type Excerpt,
  type OperationState,
  type Origin,
  type ProjectId,
  type ProjectSummary,
  type PublishIntent,
  type RecoveryItem,
  type RecoveryPlan,
  type RecoveryPlanRecord,
  type RecoveryReason,
  type RecoveryReport,
  type RecoveryResult,
  type RecoveryStrategy,
  type OpenJournal,
  type PullJournal,
  type RestoreJournal,
} from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import { PROJECT_OPERATION_KINDS, isOpen, operationError, operationStatusOf } from './journal.ts';
import { compareGitPaths } from './paths.ts';
import type {
  GitOid,
  IndexLockState,
  OperationFile,
  OperationRecord,
  ProjectGit,
  RepoProbe,
  Workspace,
} from './ports.ts';
import { recordFastForward } from './pull.ts';
import { accessCheck, fileStates, recordRestore, transition, usablePlan, type RecoveryGate } from './restore.ts';
import { assertNoBlockers } from './scope.ts';
import { sha256Hex } from './text.ts';

// Recovery (M1 plan §9.3.1, §9.4). Runs at Engine start and, under the
// project's write guard, before every change to a project. It works from
// evidence only: the journal's rows, the branch tip, the operation id in
// Draft Tide's lock and in commit metadata, and what each file holds now.
//
// Completed without asking (automatic):
// - an operation that stopped before it wrote a working file: its own lock,
//   prepared index and staging are removed; it failed;
// - a publish whose ref moved but whose index switch didn't finish: the
//   prepared index (or one rebuilt from the commit's tree) goes in and its
//   lock is released; the version was already in history;
// - a publish whose ref never moved, or that someone else has since built on.
//
// Left for the user, because files were written: a restore (finish or
// rollback), a pull (finish while the branch is still where it started, or
// rollback) or an open from GitHub (finish) that stopped part-way. Either strategy moves only files that still
// hold exactly what the restore expects; a file another program changed is
// left as it is and reported. Only a lock whose content names a Draft Tide
// operation is ever removed, and never because of its age.

export interface RecoveryService extends RecoveryGate {
  inspect(projectId: ProjectId): Promise<RecoveryReport>;
  plan(projectId: ProjectId, operationId: OperationId, strategy: RecoveryStrategy): Promise<RecoveryPlan>;
  apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<RecoveryResult>;
  // At Engine start: every project with an unfinished operation in the
  // journal. Failures are reported, never fatal.
  recoverAll(): Promise<{ projectId: ProjectId; error: string | null }[]>;
  // Whether anything needs recovery, cheaply (status).
  pending(projectId: ProjectId, lock: IndexLockState): boolean;
}

const OPEN_STATES: OperationState[] = [
  'confirmed',
  'preflight',
  'protected',
  'staged',
  'applying',
  'verified',
  'publishing',
  'committed',
  'recovery-required',
];

// What to do about one item without asking.
type AutoAction =
  | { kind: 'abandon'; error: { code: 'ENGINE_UNAVAILABLE' | 'HISTORY_CHANGED'; message: string } }
  // switched: the index switch already happened (neither this operation's
  // lock nor its prepared index is left); only the journal is behind.
  | { kind: 'switch-index'; tree: GitOid; switched?: boolean }
  | { kind: 'supersede' }
  | { kind: 'release-head-moved' }
  | { kind: 'complete' };

interface Assessed {
  item: RecoveryItem;
  rec: OperationRecord | null;
  auto: AutoAction | null;
  // For a restore, pull or open that wrote files: each file and where it is
  // now.
  files: { file: OperationFile; now: 'before' | 'after' | 'neither' }[] | null;
}

function excerpt(paths: string[]): Excerpt {
  const sorted = [...paths].sort(compareGitPaths);
  return { count: sorted.length, sample: sorted.slice(0, 50) };
}

export function createRecoveryService(ctx: ProjectContext): RecoveryService {
  const { store, journal } = ctx;

  const openOperations = (projectId: ProjectId) =>
    store
      .listOperations({ projectId, kinds: PROJECT_OPERATION_KINDS, states: OPEN_STATES })
      .filter((r) => !ctx.inFlight(r.operationId));

  // ---- Assessing what is left

  async function assess(
    p: ProjectSummary,
    repo: ProjectGit,
    probe: RepoProbe,
    workspace: Workspace | null,
  ): Promise<{ items: Assessed[]; lock: IndexLockState }> {
    const lock = await repo.indexLock();
    const prepared = new Set(await repo.preparedIndexes());
    const items: Assessed[] = [];
    const explained = new Set<OperationId>();
    for (const rec of openOperations(p.projectId)) {
      explained.add(rec.operationId);
      const switching =
        (lock.held && lock.by === 'draft-tide' && lock.operationId === rec.operationId) ||
        prepared.has(rec.operationId);
      items.push(await assessOperation(rec, repo, probe, workspace, switching));
    }
    // Draft Tide's lock with nothing open in the journal about it: an
    // operation this computer didn't record (an earlier Draft Tide, or the
    // journal was lost). The branch tip says whether its ref moved.
    if (lock.held && lock.by === 'draft-tide' && !explained.has(lock.operationId) && !ctx.inFlight(lock.operationId)) {
      let tree: GitOid | null = null;
      if (probe.headRef !== null && probe.tip !== null) {
        const [tip] = await repo.readCommits([probe.tip]);
        const meta = tip ? readCommitMetadata(tip.message) : null;
        if (tip && meta?.status === 'snapshot' && meta.metadata.operationId === lock.operationId) tree = tip.tree;
      }
      items.push({
        rec: null,
        auto: tree === null ? null : { kind: 'switch-index', tree },
        files: null,
        item: {
          operationId: lock.operationId,
          kind: 'lock',
          origin: null,
          state: null,
          reason: tree === null ? 'unknown-lock' : 'index-switch',
          startedAt: null,
          target: null,
          protection: null,
          files: null,
          strategies: tree === null ? ['rollback'] : ['finish'],
          automatic: tree !== null,
        },
      });
    }
    return { items, lock };
  }

  // switching: this operation's lock or prepared index is still in `.git`.
  async function assessOperation(
    rec: OperationRecord,
    repo: ProjectGit,
    probe: RepoProbe,
    workspace: Workspace | null,
    switching: boolean,
  ): Promise<Assessed> {
    const j = rec.journal;
    if (j.kind !== 'save' && j.kind !== 'restore' && j.kind !== 'pull' && j.kind !== 'open') {
      throw new DtError('INTERNAL_ERROR', 'a request is not a project operation');
    }
    const restore = j.kind === 'restore' ? j : null;
    // Operations that write working files.
    const writes = j.kind === 'save' ? null : j;
    const item = (
      reason: RecoveryReason,
      strategies: RecoveryStrategy[],
      automatic: boolean,
      files: Assessed['files'] = null,
    ): RecoveryItem => ({
      operationId: rec.operationId,
      kind: j.kind,
      origin: rec.origin,
      state: rec.state,
      reason,
      startedAt: rec.createdAt,
      target: writes?.target ?? null,
      protection: restore?.protection ?? null,
      files: files && {
        total: files.length,
        done: files.filter((f) => f.now === 'after').length,
        pending: files.filter((f) => f.now === 'before').length,
        conflicts: excerpt(files.filter((f) => f.now === 'neither').map((f) => f.file.path)),
      },
      strategies,
      automatic,
    });
    const interrupted = {
      code: 'ENGINE_UNAVAILABLE',
      message: 'the Engine stopped before this changed anything',
    } as const;

    // Files were written: the user decides. A pull can be finished only while
    // its branch is still at the base (it fast-forwards from there); an open
    // only finishes (the folder was empty: there is nothing to put back).
    const decide = async (reason: RecoveryReason): Promise<Assessed> => {
      const files = workspace ? await filesNow(rec, workspace, probe.trustExecutableBit) : null;
      let strategies: RecoveryStrategy[] = ['finish', 'rollback'];
      if (j.kind === 'open') strategies = ['finish'];
      else if (j.kind === 'pull' && (await repo.readRef(j.ref)) !== j.base.commit) strategies = ['rollback'];
      return { rec, auto: null, files, item: item(reason, strategies, false, files) };
    };

    switch (rec.state) {
      case 'confirmed':
      case 'preflight':
      case 'protected':
      case 'staged':
        return {
          rec,
          auto: { kind: 'abandon', error: interrupted },
          files: null,
          item: item('interrupted', ['rollback'], true),
        };
      case 'committed':
        return { rec, auto: { kind: 'complete' }, files: null, item: item('interrupted', ['finish'], true) };
      case 'applying':
      case 'verified':
      case 'recovery-required':
        return decide(writes?.reason ?? 'interrupted');
      case 'publishing':
        break;
      default:
        throw new DtError('INTERNAL_ERROR', `operation in state ${rec.state} is not open`);
    }

    const intent: PublishIntent | null = j.publish;
    if (!intent) {
      return {
        rec,
        auto: { kind: 'abandon', error: interrupted },
        files: null,
        item: item('interrupted', ['rollback'], true),
      };
    }
    // The final publish of an operation that wrote files: if it didn't
    // happen, the user decides.
    const restoreFinal = writes !== null && intent.step === 'final';
    const tip = await repo.readRef(intent.ref);
    if (tip === intent.commit) {
      // The version is in history. Its index goes in only while HEAD is still
      // on that branch; otherwise the index belongs to whatever HEAD is now.
      if (probe.headRef !== intent.ref) {
        return { rec, auto: { kind: 'release-head-moved' }, files: null, item: item('index-switch', ['finish'], true) };
      }
      // Without its lock and prepared index the switch already happened (the
      // Engine stopped before recording it): the live index is left alone,
      // whatever Git did with it since.
      return {
        rec,
        auto: { kind: 'switch-index', tree: intent.tree, switched: !switching },
        files: null,
        item: item('index-switch', ['finish'], true),
      };
    }
    if (tip === intent.expectedOld) {
      if (restoreFinal) return decide('not-recorded');
      return {
        rec,
        auto: { kind: 'abandon', error: interrupted },
        files: null,
        item: item('interrupted', ['rollback'], true),
      };
    }
    // The branch moved on. If it holds this commit, someone built on it
    // (after removing the lock by hand); otherwise this publish lost.
    if (tip !== null && (await repo.isAncestor(intent.commit, tip))) {
      return { rec, auto: { kind: 'supersede' }, files: null, item: item('history-changed', ['finish'], true) };
    }
    if (restoreFinal) return decide('history-changed');
    return {
      rec,
      auto: {
        kind: 'abandon',
        error: {
          code: 'HISTORY_CHANGED',
          message: 'another program added to the history meanwhile; nothing was overwritten',
        },
      },
      files: null,
      item: item('history-changed', ['rollback'], true),
    };
  }

  async function filesNow(rec: OperationRecord, workspace: Workspace, trustExec: boolean): Promise<Assessed['files']> {
    const files = store.listOperationFiles(rec.operationId);
    const states = await fileStates(workspace, files, trustExec);
    return files.map((file, i) => ({ file, now: states[i] ?? 'neither' }));
  }

  // ---- Doing it

  const restoreJournal = (rec: OperationRecord) => rec.journal as RestoreJournal;
  // What every file-writing operation's journal has.
  const writingJournal = (rec: OperationRecord) => rec.journal as RestoreJournal | PullJournal | OpenJournal;

  // Moves the record to a terminal or next state, keeping its kind's details.
  function settle(rec: OperationRecord, state: OperationState, patch: Record<string, unknown> = {}): OperationRecord {
    return journal.move(rec, state, { ...rec.journal, ...patch });
  }

  async function finishIndex(repo: ProjectGit, operationId: OperationId, tree: GitOid): Promise<void> {
    if (!(await repo.preparedIndexes()).includes(operationId)) await repo.prepareIndexFromTree(operationId, tree);
    await repo.finishPublish(operationId);
  }

  async function runAuto(a: Assessed, repo: ProjectGit): Promise<void> {
    const { rec, auto } = a;
    if (!auto) return;
    const id = a.item.operationId;
    const step = rec && 'publish' in rec.journal ? (rec.journal.publish?.step ?? null) : null;
    switch (auto.kind) {
      case 'abandon':
        await repo.releaseIndexLock(id);
        await repo.discardPreparedIndex(id);
        if (rec) settle(rec, 'failed', { error: auto.error, publish: null });
        if (rec?.journal.kind === 'open') await undoOpen(rec.journal);
        return;
      case 'switch-index':
        if (!auto.switched) await finishIndex(repo, id, auto.tree);
        if (!rec) return;
        if (step === 'protection') {
          // The pre-restore version is in history; the restore never wrote a
          // file.
          const j = restoreJournal(rec);
          const intent = j.publish as PublishIntent;
          settle(rec, 'failed', {
            protection: { commit: intent.commit, snapshotId: intent.snapshotId },
            publish: null,
            error: { code: 'ENGINE_UNAVAILABLE', message: 'the Engine stopped before the restore wrote any file' },
          });
        } else completePublished(rec);
        return;
      case 'release-head-moved':
      case 'supersede':
        await repo.releaseIndexLock(id);
        await repo.discardPreparedIndex(id);
        if (!rec) return;
        if (step === 'protection') {
          const intent = restoreJournal(rec).publish as PublishIntent;
          settle(rec, 'failed', {
            protection: { commit: intent.commit, snapshotId: intent.snapshotId },
            publish: null,
            error: {
              code: 'HISTORY_CHANGED',
              message: 'another program changed the branch before the restore started',
            },
          });
        } else {
          const intent = (rec.journal as { publish: PublishIntent }).publish;
          const result = { commit: intent.commit, snapshotId: intent.snapshotId };
          const kind = rec.journal.kind;
          settle(
            rec,
            'superseded',
            kind === 'save' ? { snapshot: result } : kind === 'restore' ? { restored: result } : { publish: null },
          );
        }
        return;
      case 'complete':
        settle(rec as OperationRecord, 'completed');
        return;
    }
  }

  // An open that stopped before its first file is undone as the open itself
  // would have: the project's binding goes (or it gets its old folder back),
  // and the new `.git` (and the folder, if the open made it) is removed while
  // nothing else is in it.
  async function undoOpen(j: OpenJournal): Promise<void> {
    const projectId = j.project?.projectId;
    if (!projectId) return;
    if (j.relinkedFrom !== null) store.updateProject(projectId, { root: j.relinkedFrom });
    else store.deleteProject(projectId);
    await ctx.host.removeFreshRepo(j.root, j.createdFolder).catch(() => undefined);
  }

  // A final publish whose version is in history: committed, then completed.
  function completePublished(rec: OperationRecord): OperationRecord {
    const intent = (rec.journal as { publish: PublishIntent }).publish;
    const result = { commit: intent.commit, snapshotId: intent.snapshotId };
    const kind = rec.journal.kind;
    const committed = settle(
      rec,
      'committed',
      kind === 'save'
        ? { snapshot: result, publish: null, error: null }
        : kind === 'restore'
          ? { restored: result, publish: null, reason: null, error: null }
          : { publish: null, reason: null, error: null },
    );
    return settle(committed, 'completed');
  }

  // Under the project's write guard. `skip`: the item a recovery apply is
  // about to handle itself.
  async function autoRecover(p: ProjectSummary, repo: ProjectGit, skip?: OperationId): Promise<Assessed[]> {
    const probe = await repo.probe();
    if (!probe.hasRepo) return [];
    const { items } = await assess(p, repo, probe, null);
    let changed = false;
    const left: Assessed[] = [];
    for (const a of items) {
      if (a.item.operationId === skip) continue;
      if (!a.auto) {
        if (a.rec && a.rec.state !== 'recovery-required') {
          // Files were written and the journal doesn't say so yet. Its lock
          // (a publish whose ref never moved) is released: the index still
          // matches the branch.
          await repo.releaseIndexLock(a.rec.operationId);
          await repo.discardPreparedIndex(a.rec.operationId);
          const j = writingJournal(a.rec);
          settle(a.rec, 'recovery-required', { reason: j.reason ?? a.item.reason, publish: null });
          changed = true;
        }
        left.push(a);
        continue;
      }
      try {
        await runAuto(a, repo);
        changed = true;
      } catch (e) {
        // Another Git holds the lock, say: left for the next attempt.
        if (!(e instanceof DtError)) throw e;
        left.push(a);
      }
    }
    // Leftovers of ended operations: their prepared indexes and staging.
    const open = new Set(openOperations(p.projectId).map((r) => r.operationId));
    for (const id of await repo.preparedIndexes()) {
      const rec = store.getOperation(id);
      if (rec && !isOpen(rec) && !ctx.inFlight(id)) await repo.discardPreparedIndex(id);
    }
    const keep = new Set<OperationId>([...open]);
    const running = ctx.activeOperation(p.projectId);
    if (running) keep.add(running.operationId);
    await ctx.host.clearOperationData(p.projectId, keep).catch(() => undefined);
    if (changed) {
      ctx.dropCaches(p.projectId);
      ctx.publish({ name: 'project.changed', projectId: p.projectId, reason: 'recovered' });
      ctx.publish({ name: 'operations.changed' });
    }
    return left;
  }

  const blockingError = (left: Assessed[]) => {
    const first = left[0];
    return new DtError(
      'RECOVERY_REQUIRED',
      'an earlier change stopped part-way; finish it or roll it back on the recovery screen first',
      first ? { operationId: first.item.operationId, reason: first.item.reason } : {},
    );
  };

  const gate: RecoveryGate = {
    async beforeWrite(p, repo) {
      const left = await autoRecover(p, repo);
      if (left.length > 0) throw blockingError(left);
    },
    async needsDecision(p, repo) {
      const probe = await repo.probe();
      if (!probe.hasRepo) return false;
      const { items } = await assess(p, repo, probe, null);
      return items.some((a) => !a.auto);
    },
  };

  // ---- inspect, plan, apply

  async function inspect(projectId: ProjectId): Promise<RecoveryReport> {
    const p = ctx.requireProject(projectId);
    const { repo, workspace } = await ctx.openBound(p);
    const probe = await ctx.readableRepo(repo);
    const { items, lock } = await assess(p, repo, probe, workspace);
    return {
      projectId,
      items: items.map((a) => a.item).slice(0, 100),
      lock: !lock.held ? 'free' : lock.by === 'draft-tide' ? 'draft-tide' : 'other',
      checkedAt: ctx.clock.nowIso(),
    };
  }

  async function fingerprintOf(a: Assessed, strategy: RecoveryStrategy, probe: RepoProbe, lock: IndexLockState) {
    return sha256Hex(
      canonicalJson({
        operationId: a.item.operationId,
        strategy,
        state: a.rec?.state ?? null,
        reason: a.item.reason,
        headRef: probe.headRef,
        tip: probe.tip,
        lock: lock.held ? (lock.by === 'draft-tide' ? lock.operationId : 'other') : null,
        files: a.files?.map((f) => [f.file.path, f.now]) ?? null,
      }),
    );
  }

  async function find(p: ProjectSummary, operationId: OperationId, strategy: RecoveryStrategy) {
    const { repo, workspace } = await ctx.openBound(p);
    const probe = await ctx.readableRepo(repo);
    const { items, lock } = await assess(p, repo, probe, workspace);
    const a = items.find((i) => i.item.operationId === operationId);
    if (!a) {
      throw new DtError('INVALID_ARGUMENT', 'this operation needs no recovery', { reason: 'nothing-to-recover' });
    }
    if (!a.item.strategies.includes(strategy)) {
      throw new DtError('INVALID_ARGUMENT', `this operation can't be recovered with ${strategy}`, {
        reason: 'strategy-not-available',
        strategies: a.item.strategies,
      });
    }
    return { a, repo, workspace, probe, lock, fingerprint: await fingerprintOf(a, strategy, probe, lock) };
  }

  function counts(a: Assessed, strategy: RecoveryStrategy) {
    const moving = (a.files ?? []).filter((f) => f.now === (strategy === 'finish' ? 'before' : 'after'));
    const towards = (f: OperationFile) => (strategy === 'finish' ? f.after : f.before);
    return {
      write: moving.filter((f) => towards(f.file) !== null).length,
      delete: moving.filter((f) => towards(f.file) === null).length,
      unchanged: (a.files ?? []).filter((f) => f.now === (strategy === 'finish' ? 'after' : 'before')).length,
      conflicts: excerpt((a.files ?? []).filter((f) => f.now === 'neither').map((f) => f.file.path)),
    };
  }

  async function plan(
    projectId: ProjectId,
    operationId: OperationId,
    strategy: RecoveryStrategy,
  ): Promise<RecoveryPlan> {
    const p = ctx.requireProject(projectId);
    const { a, fingerprint } = await find(p, operationId, strategy);
    const createdAt = ctx.clock.nowIso();
    const planId = PlanId.parse(crypto.randomUUID());
    const expiresAt = new Date(Date.parse(createdAt) + ctx.planTtlMs).toISOString();
    const record: RecoveryPlanRecord = { kind: 'recovery', operationId, strategy };
    store.insertPlan({ planId, projectId, createdAt, expiresAt, fingerprint, record, consumedBy: null });
    return {
      planId,
      projectId,
      operationId,
      strategy,
      createdAt,
      expiresAt,
      ...counts(a, strategy),
      records: strategy === 'finish' && a.item.kind !== 'lock' && a.item.state !== null,
    };
  }

  async function apply(projectId: ProjectId, planId: PlanId, origin: Origin): Promise<RecoveryResult> {
    const p = ctx.requireProject(projectId);
    const stored = usablePlan(ctx, projectId, planId, 'recovery');
    const { operationId, strategy } = stored.record as RecoveryPlanRecord;
    if (!store.consumePlan(planId, operationId, ctx.clock.nowIso())) {
      throw new DtError('PLAN_STALE', 'this plan was already applied; make a new one', { reason: 'used' });
    }
    const checkAccess = accessCheck(ctx, origin);
    const report = ctx.progressReporter({ operationId, origin, projectId }, 'recovery.apply');
    const settled = (outcome: 'completed' | 'failed' | 'recovery-required', code: DtError['code'] | null) =>
      ctx.publish({
        name: 'operation.settled',
        operationId,
        projectId,
        operation: 'recovery.apply',
        origin,
        outcome,
        code,
      });
    // The recovery runs under its own id: the operation it recovers is not
    // running, and must not be treated as running.
    const runId = OperationId.parse(crypto.randomUUID());
    try {
      const result = await ctx.runWrite(
        projectId,
        { operationId: runId, activity: 'recovering', origin },
        async (run) => {
          checkAccess();
          run.pastPointOfNoReturn();
          // Everything else that can be completed without asking, first.
          const { repo: other } = await ctx.openBound(p);
          await autoRecover(p, other, operationId);
          const found = await find(p, operationId, strategy);
          if (found.fingerprint !== stored.fingerprint) {
            throw new DtError('PLAN_STALE', 'the folder changed since the recovery was planned; check it again', {
              reason: 'changed',
            });
          }
          checkAccess();
          return execute(found, strategy, origin, report);
        },
      );
      settled('completed', null);
      return result;
    } catch (e) {
      const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
      settled(code === 'RECOVERY_REQUIRED' ? 'recovery-required' : 'failed', code);
      throw e;
    } finally {
      ctx.dropCaches(projectId);
      ctx.publish({ name: 'project.changed', projectId, reason: 'recovered' });
      ctx.publish({ name: 'operations.changed' });
    }
  }

  async function execute(
    found: Awaited<ReturnType<typeof find>>,
    strategy: RecoveryStrategy,
    origin: Origin,
    report: (p: {
      stage: 'apply' | 'verify' | 'publish';
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    }) => void,
  ): Promise<RecoveryResult> {
    const { a, repo, workspace, probe } = found;
    const noConflicts = { count: 0, sample: [] };
    if (a.auto) {
      await runAuto(a, repo);
      const rec = a.rec ? store.getOperation(a.rec.operationId) : null;
      // Only a lock was left: there is no operation to report.
      return { operation: rec && operationStatusOf(rec), written: 0, deleted: 0, conflicts: noConflicts };
    }
    if (!a.rec || !a.files) {
      if (a.item.kind === 'lock' && strategy === 'rollback') {
        // An unexplained lock: removed only while it still names that
        // operation (releaseIndexLock checks the content).
        await repo.releaseIndexLock(a.item.operationId);
        return { operation: null, written: 0, deleted: 0, conflicts: noConflicts };
      }
      throw new DtError('INTERNAL_ERROR', 'nothing to recover');
    }

    // A restore, pull or open that wrote files. The repo must still be usable
    // and on the operation's branch, with Git's index free (or held by this
    // operation).
    assertNoBlockers(probe.blockers);
    let rec = a.rec;
    const j = writingJournal(rec);
    if (probe.headRef !== j.ref) {
      throw new DtError(
        'RECOVERY_REQUIRED',
        `switch the folder back to branch ${j.ref.replace(/^refs\/heads\//, '')} first`,
        {
          operationId: rec.operationId,
          reason: 'branch-changed',
        },
      );
    }
    const lock = await repo.indexLock();
    if (lock.held && !(lock.by === 'draft-tide' && lock.operationId === rec.operationId)) {
      throw new DtError('LOCKED', 'another Git program is using this repository right now; nothing was changed', {
        lock: 'index',
      });
    }
    await repo.releaseIndexLock(rec.operationId);
    await repo.discardPreparedIndex(rec.operationId);
    if (rec.state !== 'recovery-required')
      rec = settle(rec, 'recovery-required', { reason: j.reason ?? a.item.reason });

    const from = strategy === 'finish' ? 'before' : 'after';
    // Rollback undoes in reverse: a file that took a folder's place goes
    // before the folder's files come back.
    const moving = a.files.filter((f) => f.now === from);
    if (strategy === 'rollback') moving.sort((x, y) => y.file.seq - x.file.seq);
    const conflicts = a.files.filter((f) => f.now === 'neither').map((f) => f.file.path);
    let written = 0;
    let deleted = 0;
    for (const { file } of moving) {
      const [src, dst] = strategy === 'finish' ? [file.before, file.after] : [file.after, file.before];
      if (!(await transition(repo, workspace, file.path, src, dst))) conflicts.push(file.path);
      else if (dst === null) deleted++;
      else written++;
      report({ stage: 'apply', filesDone: written + deleted, filesTotal: moving.length, bytesDone: 0, bytesTotal: 0 });
    }
    // Read back what this recovery wrote; anything else changing is a new
    // conflict, and recovery stops there again.
    report({ stage: 'verify', filesDone: 0, filesTotal: a.files.length, bytesDone: 0, bytesTotal: 0 });
    const want = strategy === 'finish' ? 'after' : 'before';
    const check = a.files.filter((f) => !conflicts.includes(f.file.path)).map((f) => f.file);
    const states = await fileStates(workspace, check, probe.trustExecutableBit);
    conflicts.push(...check.filter((_, i) => states[i] !== want).map((f) => f.path));
    const conflictExcerpt = excerpt([...new Set(conflicts)]);

    if (strategy === 'rollback') {
      rec = settle(rec, 'rolled-back', { conflicts: conflictExcerpt, reason: null, error: null });
      return { operation: operationStatusOf(rec), written, deleted, conflicts: conflictExcerpt };
    }
    rec = settle(rec, 'verified', { conflicts: conflictExcerpt });
    const state = { rec };
    if (j.kind !== 'restore') {
      // A pull moves the branch from its base, an open creates it.
      await recordFastForward(ctx, state, { repo, report: (p) => report({ ...p, stage: 'publish' }) });
      return { operation: operationStatusOf(state.rec), written, deleted, conflicts: conflictExcerpt };
    }
    const tip = await repo.readRef(j.ref);
    if (tip === null) throw new DtError('GIT_FAILED', 'the branch could not be read');
    await recordRestore(ctx, state, {
      repo,
      origin,
      parent: tip,
      report: (p) => report({ ...p, stage: 'publish' }),
    });
    return { operation: operationStatusOf(state.rec), written, deleted, conflicts: conflictExcerpt };
  }

  async function recoverAll() {
    const out: { projectId: ProjectId; error: string | null }[] = [];
    for (const p of store.listProjects()) {
      const open = store.listOperations({
        projectId: p.projectId,
        kinds: PROJECT_OPERATION_KINDS,
        states: OPEN_STATES,
      });
      let repo: ProjectGit;
      try {
        ({ repo } = await ctx.openBound(p));
      } catch {
        continue;
      }
      const lock = await repo.indexLock().catch(() => ({ held: false }) as const);
      if (open.length === 0 && !(lock.held && lock.by === 'draft-tide')) continue;
      try {
        await ctx.guards.run(p.projectId, () => autoRecover(p, repo));
        out.push({ projectId: p.projectId, error: null });
      } catch (e) {
        out.push({ projectId: p.projectId, error: operationError(e).message });
      }
    }
    return out;
  }

  return {
    ...gate,
    inspect,
    plan,
    apply,
    recoverAll,
    pending(projectId, lock) {
      return (
        (lock.held && lock.by === 'draft-tide' && !ctx.inFlight(lock.operationId)) ||
        openOperations(projectId).length > 0
      );
    },
  };
}
