import { z } from 'zod';
import { ProjectSummary } from './engine.ts';
import { ErrorCodeSchema } from './errors.ts';
import { CommitRef } from './history.ts';
import { IsoTimestamp, OperationId, ProjectId } from './ids.ts';
import { RelativePath } from './project-config.ts';
import { Excerpt, FolderPath, ProjectName } from './project.ts';
import { Origin } from './snapshot.ts';

// Operation states (M1 plan §9.3, TECH_STACK §6.4):
//
//   planned → confirmed → preflight → protected → staged
//           → applying → verified → publishing → committed → completed
//                         └→ recovery-required
//
// Saves have no protected, staged, applying or verified stage. `publishing`
// is the lock-first switch of ref and index (§9.3.1); `committed` means Git
// holds the result and only the Engine's own bookkeeping is left. Plans are
// not operations: an operation starts when an apply is accepted (confirmed).
//
// A request for something only the app may do waits in `awaiting-user` until
// the user completes it (completed), declines it (denied) or the requester
// cancels it. The other terminal states end operations that stopped before
// changing anything (failed, cancelled), that recovery found someone else had
// built on (superseded), or whose files recovery put back (rolled-back).
export const OPERATION_STATES = [
  'planned',
  'confirmed',
  'preflight',
  'protected',
  'staged',
  'applying',
  'verified',
  'publishing',
  'committed',
  'completed',
  'recovery-required',
  'awaiting-user',
  'failed',
  'cancelled',
  'superseded',
  'denied',
  'rolled-back',
] as const;
export const OperationState = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof OperationState>;

export const TERMINAL_OPERATION_STATES: ReadonlySet<OperationState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'superseded',
  'denied',
  'rolled-back',
]);

export function isTerminalState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.has(state);
}

//   save             saving a version
//   restore          restoring a version (with its protection version)
//   connect-request  an agent asked the user to connect a folder in the app
export const OPERATION_KINDS = ['save', 'restore', 'connect-request'] as const;
export const OperationKind = z.enum(OPERATION_KINDS);
export type OperationKind = z.infer<typeof OperationKind>;

// Why an operation ended without completing: failed, cancelled, denied, or
// waiting for recovery.
export const OperationError = z.strictObject({ code: ErrorCodeSchema, message: z.string().max(4000) });
export type OperationError = z.infer<typeof OperationError>;

const StatusBase = {
  operationId: OperationId,
  projectId: ProjectId.nullable(),
  origin: Origin,
  state: OperationState,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  error: OperationError.nullable(),
};

// What any channel can read about an operation (`operation.status`).
export const OperationStatus = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('save'),
    ...StatusBase,
    // The version, once it is in history.
    snapshot: CommitRef.nullable(),
  }),
  z.strictObject({
    kind: z.literal('restore'),
    ...StatusBase,
    target: CommitRef,
    // The pre-restore version holding the unsaved changes, when there were any.
    protection: CommitRef.nullable(),
    // The restore version, once it is in history.
    restored: CommitRef.nullable(),
    // Files another program changed while the restore wrote them: they were
    // left as that program wrote them.
    conflicts: Excerpt,
  }),
  z.strictObject({
    kind: z.literal('connect-request'),
    ...StatusBase,
    // What the agent asked for. The folder is only a suggestion: nothing in
    // it is read until the user picks it in the app.
    request: z.strictObject({
      root: FolderPath,
      name: ProjectName.nullable(),
      entryFiles: z.array(RelativePath).max(16),
    }),
    // The project the user connected in answer.
    project: ProjectSummary.nullable(),
  }),
]);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const OperationIdInput = z.strictObject({ operationId: OperationId });

//   cancelled   it stopped; nothing more will change
//   cancelling  it stops at its next safe boundary
//   too-late    it is already changing files and finishes (or needs recovery)
//   ended       it had already ended
export const CANCEL_OUTCOMES = ['cancelled', 'cancelling', 'too-late', 'ended'] as const;

export const OperationCancelResult = z.strictObject({
  outcome: z.enum(CANCEL_OUTCOMES),
  operation: OperationStatus,
});
export type OperationCancelResult = z.infer<typeof OperationCancelResult>;

// What the app shows besides projects (M1 plan §4.1 設定 / 診斷).
export const OperationList = z.strictObject({
  // Agent requests waiting for the user, oldest first.
  requests: z.array(OperationStatus).max(50),
  // Restores an agent made that the user hasn't dismissed yet, newest first.
  notices: z.array(OperationStatus).max(50),
  // Operations that stopped part-way and need recovery, in any project.
  attention: z.array(OperationStatus).max(100),
});
export type OperationList = z.infer<typeof OperationList>;

// ---- Asking the user to connect a folder (M1 plan §9.1)
//
// Connecting grants Draft Tide a folder, so only the user can do it, in the
// app's native picker. The tool channel may only ask: the answer is always
// CONFIRMATION_REQUIRED with an operation id to follow (operation.status).
export const MAX_PENDING_REQUESTS = 20;

export const ConnectRequestInput = z.strictObject({
  root: FolderPath,
  name: ProjectName.optional(),
  entryFiles: z.array(RelativePath).max(16).optional(),
});
