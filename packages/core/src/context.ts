import {
  DRAFT_TIDE_IDENTITY,
  DtError,
  PLAN_TTL_MS,
  type Activity,
  type CommitIdentity,
  type EngineEvent,
  type OperationId,
  type Origin,
  type ProjectId,
  type ProjectSummary,
  type RestoreProgress,
  type SaveProgress,
} from '@draft-tide/contracts';
import { buildLineIndex, type LineIndex } from './history.ts';
import { createJournal, type Journal } from './journal.ts';
import type {
  Clock,
  EventSink,
  GitOid,
  LocalStore,
  ProjectGit,
  ProjectHost,
  RepoProbe,
  TestHooks,
  Workspace,
} from './ports.ts';
import { assertNoBlockers } from './scope.ts';
import { HashCache } from './working.ts';
import { createProjectWriteGuards, type ProjectWriteGuards } from './write-guards.ts';

// What the project use cases share: the ports, the per-project write guards,
// the journal, rebuildable views of Git, and the operations running now.

export interface ProjectServiceOptions {
  store: LocalStore;
  host: ProjectHost;
  clock: Clock;
  events: EventSink;
  guards?: ProjectWriteGuards;
  // Before GitHub sign-in (M1-07), the fixed Draft Tide identity.
  identity?: CommitIdentity;
  // At most one progress event per operation this often (and on every stage
  // change).
  progressIntervalMs?: number;
  // Tests shorten capture retries, the wait for another Git's lock and how
  // long a plan stays valid.
  retryDelayMs?: (attempt: number) => number;
  lockWaitMs?: number;
  planTtlMs?: number;
  testHooks?: TestHooks;
}

export interface ActiveOperation {
  operationId: OperationId;
  activity: Activity;
  origin: Origin;
}

export interface WriteRun {
  signal: AbortSignal;
  // From here on cancelling has no effect: the operation is changing files
  // and finishes, or stops for recovery (M1 plan §3).
  pastPointOfNoReturn(): void;
}

type ProgressOperation = 'snapshot.create' | 'restore.apply' | 'recovery.apply';

export interface ProjectContext {
  readonly store: LocalStore;
  readonly host: ProjectHost;
  readonly clock: Clock;
  readonly guards: ProjectWriteGuards;
  readonly identity: CommitIdentity;
  readonly journal: Journal;
  readonly hooks: TestHooks;
  readonly options: ProjectServiceOptions;
  readonly planTtlMs: number;
  // Plain functions, safe to pass around on their own.
  readonly publish: (event: EngineEvent) => void;
  readonly requireProject: (projectId: ProjectId) => ProjectSummary;
  readonly openBound: (p: ProjectSummary) => Promise<{ root: string; repo: ProjectGit; workspace: Workspace }>;
  readonly readableRepo: (repo: ProjectGit) => Promise<RepoProbe & { headRef: string; branch: string }>;
  readonly lineIndex: (projectId: ProjectId, repo: ProjectGit, tip: GitOid) => Promise<LineIndex>;
  hashCache(projectId: ProjectId): HashCache;
  dropCaches(projectId: ProjectId): void;
  // Runs a change to one project under its write guard, after every earlier
  // one. Cancellable (CANCELLED) until the run says otherwise; fn checks the
  // signal before it starts, and records any failure in the journal before it
  // returns (under the guard, where no other change can move the row).
  runWrite<T>(projectId: ProjectId, op: ActiveOperation, fn: (run: WriteRun) => Promise<T>): Promise<T>;
  activeOperation(projectId: ProjectId): ActiveOperation | null;
  // Running or waiting for its turn in this Engine.
  inFlight(operationId: OperationId): boolean;
  // null: not running in this Engine.
  cancel(operationId: OperationId): 'cancelling' | 'too-late' | null;
  progressReporter(
    op: ActiveOperation & { projectId: ProjectId },
    operation: ProgressOperation,
  ): (progress: SaveProgress | RestoreProgress) => void;
}

interface Running {
  projectId: ProjectId;
  op: ActiveOperation;
  controller: AbortController;
  cancellable: boolean;
}

export function cancelledError(): DtError {
  return new DtError('CANCELLED', 'the operation was cancelled before it changed anything');
}

export function createProjectContext(options: ProjectServiceOptions): ProjectContext {
  const { store, host, clock, events } = options;
  const guards = options.guards ?? createProjectWriteGuards();
  const progressIntervalMs = options.progressIntervalMs ?? 150;
  // Rebuildable views of Git, per project (M1 plan §6.1): digests of
  // unchanged files for status, and the branch's line for history.
  const hashCaches = new Map<ProjectId, HashCache>();
  const lineIndexes = new Map<ProjectId, LineIndex>();
  const running = new Map<OperationId, Running>();
  const active = new Map<ProjectId, Running>();

  const ctx: ProjectContext = {
    store,
    host,
    clock,
    guards,
    identity: options.identity ?? DRAFT_TIDE_IDENTITY,
    journal: createJournal(store, clock),
    hooks: options.testHooks ?? {},
    options,
    planTtlMs: options.planTtlMs ?? PLAN_TTL_MS,

    publish: (event) => events.publish(event),

    requireProject: (projectId) => {
      const p = store.getProject(projectId);
      if (!p) throw new DtError('PROJECT_NOT_BOUND', 'no connected project has this id', { projectId });
      return p;
    },

    // The bound folder, still at the same canonical path. A folder that is
    // gone, or whose path now leads elsewhere (a symlink swapped in), is
    // unavailable: nothing is read from wherever it points now.
    openBound: async (p) => {
      const root = await host.canonicalRoot(p.root);
      if (root !== p.root) {
        throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the project folder now resolves to another location', {
          reason: 'moved',
        });
      }
      return { root, repo: host.openRepo(root), workspace: host.openWorkspace(root) };
    },

    // A repo whose branch can be read: present, on a branch, in a form Git
    // and Draft Tide can read. A Git operation in progress doesn't stop
    // reading.
    readableRepo: async (repo) => {
      const probe = await repo.probe();
      if (!probe.hasRepo) {
        throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the design folder's history (.git) is missing", {
          reason: 'repo-missing',
        });
      }
      if (probe.headRef === null || probe.branch === null) {
        assertNoBlockers(probe.blockers);
        throw new DtError('GIT_FAILED', 'the current branch could not be read');
      }
      return probe as RepoProbe & { headRef: string; branch: string };
    },

    lineIndex: async (projectId, repo, tip) => {
      const cached = lineIndexes.get(projectId);
      if (cached?.tip === tip) return cached;
      const built = await buildLineIndex(repo, tip);
      lineIndexes.set(projectId, built);
      return built;
    },

    hashCache(projectId) {
      let cache = hashCaches.get(projectId);
      if (!cache) hashCaches.set(projectId, (cache = new HashCache()));
      return cache;
    },

    dropCaches(projectId) {
      hashCaches.delete(projectId);
      lineIndexes.delete(projectId);
    },

    async runWrite(projectId, op, fn) {
      const entry: Running = { projectId, op, controller: new AbortController(), cancellable: true };
      running.set(op.operationId, entry);
      try {
        return await guards.run(projectId, async () => {
          active.set(projectId, entry);
          try {
            // fn checks the signal first thing, so that a cancel while it
            // waited is recorded in its journal under the guard too.
            return await fn({
              signal: entry.controller.signal,
              pastPointOfNoReturn: () => {
                entry.cancellable = false;
              },
            });
          } finally {
            active.delete(projectId);
          }
        });
      } finally {
        running.delete(op.operationId);
      }
    },

    activeOperation(projectId) {
      return active.get(projectId)?.op ?? null;
    },

    inFlight: (operationId) => running.has(operationId),

    cancel(operationId) {
      const entry = running.get(operationId);
      if (!entry) return null;
      if (!entry.cancellable) return 'too-late';
      entry.controller.abort(cancelledError());
      return 'cancelling';
    },

    progressReporter(op, operation) {
      let lastStage = '';
      let lastAt = 0;
      return (progress) => {
        const now = Date.now();
        if (progress.stage === lastStage && now - lastAt < progressIntervalMs) return;
        lastStage = progress.stage;
        lastAt = now;
        events.publish({
          name: 'operation.progress',
          operationId: op.operationId,
          projectId: op.projectId,
          operation,
          origin: op.origin,
          progress,
        });
      };
    },
  };
  return ctx;
}
