import {
  DtError,
  MAX_PENDING_REQUESTS,
  OperationId,
  type GitHubUser,
  type OperationCancelResult,
  type OperationJournal,
  type OperationList,
  type OperationState,
  type OperationStatus,
  type Origin,
  type ProjectId,
  type ProjectSummary,
  type RemoteBinding,
} from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import { PROJECT_OPERATION_KINDS, REQUEST_KINDS, isOpen, isRequestKind, operationStatusOf } from './journal.ts';
import type { OperationRecord } from './ports.ts';

// Operation status and cancel for every channel, and the requests the tool
// channel may make for what only the app does (M1 plan §9.1, §11.1). Draft
// Tide never acts on a request: the user does, in the app, or declines it.

export interface OperationService {
  status(operationId: OperationId): OperationStatus;
  cancel(operationId: OperationId): OperationCancelResult;
  list(): OperationList;
  // Records the request and answers CONFIRMATION_REQUIRED, always.
  requestConnect(
    input: { root: string; name?: string | undefined; entryFiles?: string[] | undefined },
    origin: Origin,
  ): never;
  // Asks the user to sign in to GitHub (M1-07). INVALID_ARGUMENT
  // (already-signed-in) when someone is.
  requestLogin(origin: Origin): never;
  // Asks the user to connect a project to a GitHub repository (M1-07).
  requestRemoteConnect(projectId: ProjectId, origin: Origin): never;
  decline(operationId: OperationId): OperationStatus;
  dismiss(operationId: OperationId): OperationStatus;
  // The user connected a folder in answer to this request.
  completeRequest(requestId: OperationId, project: ProjectSummary): void;
  // The user signed in: every waiting login request is answered.
  completeLoginRequests(user: GitHubUser): void;
  // The user connected the project's remote: its waiting requests are
  // answered (and requestId, whichever project it named).
  completeRemoteConnectRequests(projectId: ProjectId, remote: RemoteBinding): void;
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

// An absolute path on any platform; nothing is looked up. The folder is only a
// suggestion until the user picks it.
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

export function createOperationService(ctx: ProjectContext): OperationService {
  const { store, journal } = ctx;

  function get(operationId: OperationId): OperationRecord {
    const rec = store.getOperation(operationId);
    if (!rec) throw new DtError('INVALID_ARGUMENT', 'no operation has this id', { reason: 'unknown-operation' });
    return rec;
  }

  function request(operationId: OperationId): OperationRecord {
    const rec = get(operationId);
    if (!isRequestKind(rec.journal.kind)) {
      throw new DtError('INVALID_ARGUMENT', 'this operation is not a request', { reason: 'not-a-request' });
    }
    return rec;
  }

  const changed = () => ctx.publish({ name: 'operations.changed' });

  // Records a request (awaiting-user) and answers CONFIRMATION_REQUIRED.
  function record(
    projectId: ProjectId | null,
    origin: Origin,
    j: OperationJournal,
    what: string,
    operation: string,
  ): never {
    const waiting = store.listOperations({ kinds: REQUEST_KINDS, states: ['awaiting-user'] }).length;
    if (waiting >= MAX_PENDING_REQUESTS) {
      throw new DtError('RESOURCE_BUDGET_EXCEEDED', 'too many requests are waiting for the user already', {
        budget: 'pending-requests',
        limit: MAX_PENDING_REQUESTS,
      });
    }
    const operationId = OperationId.parse(crypto.randomUUID());
    journal.begin({ operationId, projectId, kind: j.kind, origin, state: 'awaiting-user', journal: j });
    changed();
    throw new DtError(
      'CONFIRMATION_REQUIRED',
      `Only the user can ${what}. The request is waiting in the Draft Tide app; follow it with operation.status.`,
      { operationId, operation },
    );
  }

  function completeWaiting(rec: OperationRecord, j: OperationJournal): boolean {
    return journal.tryMove(rec, 'completed', j) !== null;
  }

  return {
    status: (operationId) => operationStatusOf(get(operationId)),

    cancel(operationId) {
      const rec = get(operationId);
      if (isRequestKind(rec.journal.kind)) {
        if (rec.state !== 'awaiting-user') return { outcome: 'ended', operation: operationStatusOf(rec) };
        const next = journal.tryMove(rec, 'cancelled', {
          ...rec.journal,
          error: { code: 'CANCELLED', message: 'the requester withdrew the request' },
        });
        changed();
        const now = next ?? get(operationId);
        return { outcome: next ? 'cancelled' : 'ended', operation: operationStatusOf(now) };
      }
      const running = ctx.cancel(operationId);
      if (running) return { outcome: running, operation: operationStatusOf(get(operationId)) };
      // Not running in this Engine: ended, or stopped part-way and waiting
      // for recovery (cancelling can't undo written files).
      return { outcome: isOpen(rec) ? 'too-late' : 'ended', operation: operationStatusOf(rec) };
    },

    list() {
      const requests = store.listOperations({ kinds: REQUEST_KINDS, states: ['awaiting-user'], limit: 50 });
      // Restores, pulls and opens an agent made: the app says so, and points
      // at the protection version (M1 plan §9.1 可見性).
      const notices = store
        .listOperations({
          kinds: ['restore', 'pull', 'open'],
          states: ['completed', 'recovery-required'],
          unacknowledged: true,
          newestFirst: true,
          limit: 200,
        })
        .filter((r) => r.origin !== 'gui')
        .slice(0, 50);
      const attention = store
        .listOperations({ kinds: PROJECT_OPERATION_KINDS, states: OPEN_STATES, limit: 200 })
        .filter((r) => !ctx.inFlight(r.operationId))
        .slice(0, 100);
      return {
        requests: requests.map(operationStatusOf),
        notices: notices.map(operationStatusOf),
        attention: attention.map(operationStatusOf),
      };
    },

    requestConnect(input, origin) {
      if (!ABSOLUTE.test(input.root)) {
        throw new DtError('INVALID_ARGUMENT', 'the folder must be given as an absolute path', {
          reason: 'relative-path',
        });
      }
      return record(
        null,
        origin,
        {
          kind: 'connect-request',
          root: input.root,
          name: input.name?.trim() ? input.name.trim() : null,
          entryFiles: [...new Set(input.entryFiles ?? [])],
          project: null,
          error: null,
        },
        'connect a folder',
        'project.connect',
      );
    },

    requestLogin(origin) {
      return record(
        null,
        origin,
        { kind: 'login-request', user: null, error: null },
        'sign in to GitHub',
        'auth.login',
      );
    },

    requestRemoteConnect(projectId, origin) {
      ctx.requireProject(projectId);
      return record(
        projectId,
        origin,
        { kind: 'remote-connect-request', remote: null, error: null },
        'connect a project to a GitHub repository and push it',
        'remote.connect',
      );
    },

    decline(operationId) {
      const rec = request(operationId);
      if (rec.state !== 'awaiting-user') return operationStatusOf(rec);
      const next = journal.tryMove(rec, 'denied', {
        ...rec.journal,
        error: { code: 'APPROVAL_DENIED', message: 'the user declined the request in the Draft Tide app' },
      });
      changed();
      return operationStatusOf(next ?? get(operationId));
    },

    dismiss(operationId) {
      get(operationId);
      store.acknowledgeOperation(operationId);
      changed();
      return operationStatusOf(get(operationId));
    },

    completeRequest(requestId, project) {
      const rec = store.getOperation(requestId);
      if (rec?.journal.kind !== 'connect-request' || rec.state !== 'awaiting-user') return;
      journal.tryMove(rec, 'completed', { ...rec.journal, project });
      changed();
    },

    completeLoginRequests(user) {
      let any = false;
      for (const rec of store.listOperations({ kinds: ['login-request'], states: ['awaiting-user'] })) {
        if (rec.journal.kind === 'login-request') any = completeWaiting(rec, { ...rec.journal, user }) || any;
      }
      if (any) changed();
    },

    completeRemoteConnectRequests(projectId, remote) {
      let any = false;
      for (const rec of store.listOperations({
        projectId,
        kinds: ['remote-connect-request'],
        states: ['awaiting-user'],
      })) {
        if (rec.journal.kind === 'remote-connect-request')
          any = completeWaiting(rec, { ...rec.journal, remote }) || any;
      }
      if (any) changed();
    },
  };
}
