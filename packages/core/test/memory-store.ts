import { TERMINAL_OPERATION_STATES, type AgentAccess, type ProjectSummary } from '@draft-tide/contracts';
import type {
  LocalStore,
  OperationFile,
  OperationRecord,
  QueuedPush,
  StoredPlan,
  StoredPreview,
  StoredRemote,
} from '../src/index.ts';

// An in-memory stand-in for the SQLite store, with the same compare-and-set
// and once-only semantics. The real store's own tests are in local-store; the
// Engine runs on it in the companion's integration tests.
export function memoryStore(projects: unknown[] = []): LocalStore & {
  access: AgentAccess;
  operations: Map<string, OperationRecord>;
  plans: Map<string, StoredPlan>;
  previews: Map<string, StoredPreview>;
} {
  const list = projects as ProjectSummary[];
  const operations = new Map<string, OperationRecord>();
  const files = new Map<string, OperationFile[]>();
  const plans = new Map<string, StoredPlan>();
  const previews = new Map<string, StoredPreview>();
  const remotes = new Map<string, StoredRemote>();
  const queue = new Map<string, QueuedPush>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    storageSchemaVersion: 2,
    sqliteVersion: 'test',
    access: { enabled: false, updatedAt: null },
    operations,
    plans,
    previews,
    getAgentAccess() {
      return this.access;
    },
    setAgentAccess(enabled, at) {
      this.access = { enabled, updatedAt: at };
      return this.access;
    },
    listProjects() {
      return list;
    },
    getProject: (id) => list.find((p) => p.projectId === id) ?? null,
    findProjectByRoot: (root) => list.find((p) => p.root === root) ?? null,
    insertProject: (p) => void list.push(p),
    updateProject: () => undefined,
    deleteProject(id) {
      const i = list.findIndex((p) => p.projectId === id);
      if (i >= 0) list.splice(i, 1);
      remotes.delete(id);
      queue.delete(id);
    },
    storeId: () => '00000000-0000-4000-8000-000000000000',
    getRemote: (id) => clone(remotes.get(id) ?? null),
    listRemotes: () => clone([...remotes.values()]),
    putRemote: (projectId, remote) =>
      void remotes.set(projectId, {
        projectId,
        remote: clone(remote),
        remoteTip: null,
        lastCheckAt: null,
        lastPushAt: null,
        lastError: null,
      }),
    deleteRemote(id) {
      remotes.delete(id);
      queue.delete(id);
    },
    updateRemoteState(id, change) {
      const r = remotes.get(id);
      if (r) Object.assign(r, clone(change));
    },
    queuePush(projectId, at) {
      const q = queue.get(projectId);
      queue.set(
        projectId,
        q ? { ...q, nextAttemptAt: at } : { projectId, requestedAt: at, attempts: 0, nextAttemptAt: at },
      );
    },
    getQueuedPush: (id) => clone(queue.get(id) ?? null),
    listQueuedPushes: () => clone([...queue.values()]),
    deferPush(id, attempts, nextAttemptAt) {
      const q = queue.get(id);
      if (q) queue.set(id, { ...q, attempts, nextAttemptAt });
    },
    dequeuePush: (id) => void queue.delete(id),

    insertOperation(op) {
      if (operations.has(op.operationId)) throw new Error('duplicate operation');
      operations.set(op.operationId, clone(op));
    },
    updateOperation(id, expect, change) {
      const rec = operations.get(id);
      if (!rec || !expect.includes(rec.state)) return false;
      operations.set(id, { ...rec, state: change.state, journal: clone(change.journal), updatedAt: change.at });
      return true;
    },
    getOperation: (id) => {
      const rec = operations.get(id);
      return rec ? clone(rec) : null;
    },
    listOperations(q) {
      let out = [...operations.values()].filter(
        (r) =>
          (q.projectId === undefined || r.projectId === q.projectId) &&
          (q.kinds === undefined || q.kinds.includes(r.kind)) &&
          (q.states === undefined || q.states.includes(r.state)) &&
          (!q.unacknowledged || !r.acknowledged),
      );
      if (q.newestFirst) out = out.reverse();
      return clone(q.limit === undefined ? out : out.slice(0, q.limit));
    },
    acknowledgeOperation(id) {
      const rec = operations.get(id);
      if (rec) rec.acknowledged = true;
    },
    insertOperationFiles: (id, list) => void files.set(id, clone([...list])),
    listOperationFiles: (id) => clone(files.get(id) ?? []),
    markOperationFile(id, seq, done) {
      const f = files.get(id)?.find((x) => x.seq === seq);
      if (f) f.done = done;
    },
    insertPlan: (plan) => void plans.set(plan.planId, clone(plan)),
    getPlan: (id) => {
      const plan = plans.get(id);
      return plan ? clone(plan) : null;
    },
    consumePlan(id, by, _at, start) {
      const plan = plans.get(id);
      if (!plan || plan.consumedBy !== null) return false;
      plan.consumedBy = by;
      if (start) this.insertOperation(start);
      return true;
    },
    prune(before) {
      for (const [id, r] of operations) {
        if (TERMINAL_OPERATION_STATES.has(r.state) && r.updatedAt < before) operations.delete(id);
      }
    },
    getPreview: (projectId, key) => {
      const p = previews.get(`${projectId}/${key}`);
      return p ? clone(p) : null;
    },
    putPreview: (entry) => {
      // Re-inserted at the end, as a fresh row would be.
      previews.delete(`${entry.projectId}/${entry.key}`);
      previews.set(`${entry.projectId}/${entry.key}`, clone(entry));
    },
    touchPreview(projectId, key, at) {
      const p = previews.get(`${projectId}/${key}`);
      if (p) p.usedAt = at;
    },
    deletePreview: (projectId, key) => void previews.delete(`${projectId}/${key}`),
    listPreviews: () =>
      [...previews.values()]
        .map((p) => ({ projectId: p.projectId, key: p.key, usedAt: p.usedAt, bytes: p.bytes }))
        .sort((a, b) => (a.usedAt < b.usedAt ? -1 : a.usedAt > b.usedAt ? 1 : 0)),
  };
}
