import {
  DtError,
  OperationStatus,
  isTerminalState,
  type OperationError,
  type OperationJournal,
  type OperationState,
} from '@draft-tide/contracts';
import type { Clock, LocalStore, OperationRecord } from './ports.ts';

// The operation journal's state machine (M1 plan §9.3, TECH_STACK §6.4). Each
// step is recorded before it happens, compare-and-set on the state the caller
// last saw, so a crash leaves a row that says how far the operation got and
// two writers can never both move it.
//
// Which state may follow which. Anything else is a bug and is refused before
// it reaches the database.
const NEXT: Record<OperationState, readonly OperationState[]> = {
  planned: ['confirmed'],
  confirmed: ['preflight', 'failed', 'cancelled'],
  preflight: ['publishing', 'protected', 'staged', 'failed', 'cancelled'],
  // Saves and the pre-restore version publish from preflight; the restore
  // version, a pull and an open from verified. Pulls and opens have no
  // protection step (a pull needs a folder without unsaved changes, an open
  // an empty one).
  publishing: ['protected', 'committed', 'failed', 'superseded', 'recovery-required'],
  protected: ['staged', 'failed', 'cancelled'],
  staged: ['applying', 'failed', 'cancelled'],
  // failed only while no file has been written yet.
  applying: ['verified', 'failed', 'recovery-required'],
  verified: ['publishing', 'recovery-required'],
  committed: ['completed'],
  'recovery-required': ['verified', 'publishing', 'committed', 'rolled-back', 'superseded', 'failed'],
  'awaiting-user': ['completed', 'denied', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: [],
  denied: [],
  'rolled-back': [],
};

export function canMove(from: OperationState, to: OperationState): boolean {
  return NEXT[from].includes(to);
}

export interface Journal {
  begin(op: Omit<OperationRecord, 'createdAt' | 'updatedAt' | 'acknowledged'>): OperationRecord;
  // Moves the operation on; INTERNAL_ERROR for a transition the state
  // machine doesn't allow or a row that changed meanwhile.
  move(rec: OperationRecord, state: OperationState, journal?: OperationJournal): OperationRecord;
  // The same, but null when the row is no longer in rec.state (a request the
  // user and the agent answered at the same moment).
  tryMove(rec: OperationRecord, state: OperationState, journal?: OperationJournal): OperationRecord | null;
  // New details, same state.
  note(rec: OperationRecord, journal: OperationJournal): OperationRecord;
}

export function createJournal(store: LocalStore, clock: Clock): Journal {
  const write = (rec: OperationRecord, state: OperationState, journal: OperationJournal): OperationRecord | null => {
    if (state !== rec.state && !canMove(rec.state, state)) {
      throw new DtError('INTERNAL_ERROR', `operation state ${rec.state} cannot become ${state}`);
    }
    const at = clock.nowIso();
    if (!store.updateOperation(rec.operationId, [rec.state], { state, journal, at })) return null;
    return { ...rec, state, journal, updatedAt: at };
  };
  const changed = () => new DtError('INTERNAL_ERROR', 'the operation was changed by something else');
  return {
    begin(op) {
      const at = clock.nowIso();
      const rec: OperationRecord = { ...op, createdAt: at, updatedAt: at, acknowledged: false };
      store.insertOperation(rec);
      return rec;
    },
    move(rec, state, journal = rec.journal) {
      const next = write(rec, state, journal);
      if (!next) throw changed();
      return next;
    },
    tryMove(rec, state, journal = rec.journal) {
      return write(rec, state, journal);
    },
    note(rec, journal) {
      const next = write(rec, rec.state, journal);
      if (!next) throw changed();
      return next;
    },
  };
}

// What a failure looks like in the journal and in operation.status.
export function operationError(e: unknown): OperationError {
  if (e instanceof DtError) return { code: e.code, message: e.message.slice(0, 4000) };
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'INTERNAL_ERROR', message: message.slice(0, 4000) };
}

const NO_CONFLICTS = { count: 0, sample: [] };

// The journal row as any channel may read it.
export function operationStatusOf(rec: OperationRecord): OperationStatus {
  const base = {
    operationId: rec.operationId,
    projectId: rec.projectId,
    origin: rec.origin,
    state: rec.state,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  const j = rec.journal;
  let status: OperationStatus;
  if (j.kind === 'save') {
    status = { kind: 'save', ...base, error: j.error, snapshot: j.snapshot };
  } else if (j.kind === 'restore') {
    status = {
      kind: 'restore',
      ...base,
      error: j.error,
      target: j.target,
      protection: j.protection,
      restored: j.restored,
      conflicts: j.conflicts ?? NO_CONFLICTS,
    };
  } else if (j.kind === 'pull') {
    status = { kind: 'pull', ...base, error: j.error, from: j.base, target: j.target, conflicts: j.conflicts };
  } else if (j.kind === 'open') {
    status = {
      kind: 'open',
      ...base,
      error: j.error,
      repo: j.remote,
      root: j.root,
      target: j.target,
      conflicts: j.conflicts,
      project: j.project,
    };
  } else if (j.kind === 'login-request') {
    status = { kind: 'login-request', ...base, error: j.error, user: j.user };
  } else if (j.kind === 'remote-connect-request') {
    status = { kind: 'remote-connect-request', ...base, error: j.error, remote: j.remote };
  } else {
    status = {
      kind: 'connect-request',
      ...base,
      error: j.error,
      request: { root: j.root, name: j.name, entryFiles: j.entryFiles },
      project: j.project,
    };
  }
  // A row that breaks the contract (a corrupt database) is never passed on.
  const checked = OperationStatus.safeParse(status);
  if (!checked.success) throw new DtError('STORAGE_IO_FAILED', 'an operation record could not be read');
  return checked.data;
}

// Requests the tool channel made for what only the user may do in the app.
export const REQUEST_KINDS = ['connect-request', 'login-request', 'remote-connect-request'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export function isRequestKind(kind: string): kind is RequestKind {
  return (REQUEST_KINDS as readonly string[]).includes(kind);
}

// Operations that change a project's folder or history and are journaled
// step by step (recovery looks at these).
export const PROJECT_OPERATION_KINDS = ['save', 'restore', 'pull', 'open'] as const;

export function isOpen(rec: OperationRecord): boolean {
  return !isTerminalState(rec.state) && rec.state !== 'awaiting-user';
}
