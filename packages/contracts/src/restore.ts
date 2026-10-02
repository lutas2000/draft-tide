import { z } from 'zod';
import { ErrorCodeSchema } from './errors.ts';
import { CommitRef, VersionInfo, VersionRef } from './history.ts';
import { IsoTimestamp, OperationId, PlanId, ProjectId } from './ids.ts';
import { OperationState, OperationStatus } from './operation.ts';
import { Excerpt } from './project.ts';
import { Origin } from './snapshot.ts';

// Restoring a version and recovering an operation that stopped part-way (M1
// plan §9.2–9.4). Both write working files, so both are plan → apply: the plan
// says exactly what would change and carries a fingerprint of the folder; the
// apply re-checks it under the project's write guard (PLAN_STALE). A plan id is
// never authorization: the GUI's confirmation, or agent access for the tool
// channel, is.

const DisplayPath = z.string().max(4096);
const Count = z.number().int().nonnegative();

// How long a plan may wait for its apply.
export const PLAN_TTL_MS = 30 * 60 * 1000;

// ---- Restore plan

export const RestorePlanInput = z.strictObject({ projectId: ProjectId, target: VersionRef });

// What applying does to one path, compared with the folder as it is now.
export const RESTORE_CHANGES = ['overwrite', 'add', 'delete'] as const;
export const RestoreChangeKind = z.enum(RESTORE_CHANGES);
export type RestoreChangeKind = z.infer<typeof RestoreChangeKind>;

export const RestoreChange = z.strictObject({ path: DisplayPath, change: RestoreChangeKind });
export type RestoreChange = z.infer<typeof RestoreChange>;

// Something in the way that no version holds, so restoring would destroy it
// (M1 plan §9.2). Files Draft Tide saves are never in the way: the unsaved
// ones go into the pre-restore version first.
//   unsaved-file  a file outside what Draft Tide saves (ignored or excluded)
//   folder        a folder holding such files, where the version has a file
//   link          a symlink or other special entry (never written through)
//   parent        a parent folder of the path is one of the above
export const COLLISION_REASONS = ['unsaved-file', 'folder', 'link', 'parent'] as const;
export const CollisionReason = z.enum(COLLISION_REASONS);
export type CollisionReason = z.infer<typeof CollisionReason>;

export const RestoreCollision = z.strictObject({ path: DisplayPath, reason: CollisionReason });
export type RestoreCollision = z.infer<typeof RestoreCollision>;

// `.drafttide.json` goes back with the version, unless the version's copy
// can't serve this project: then the current one is kept.
//   restored   the version's settings come back
//   unchanged  they are the same as now
//   kept       the current settings stay (reason says why)
export const SETTINGS_ACTIONS = ['restored', 'unchanged', 'kept'] as const;
export const KEPT_SETTINGS_REASONS = ['missing', 'invalid', 'other-project'] as const;

export const RestorePlan = z.strictObject({
  planId: PlanId,
  projectId: ProjectId,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  branch: z.string().max(1024),
  // The newest commit now; the restore goes on top of it (or on top of the
  // pre-restore version).
  base: VersionInfo,
  target: VersionInfo,
  // Against the folder as it is now, not against the newest version.
  summary: z.strictObject({ overwrite: Count, add: Count, delete: Count, unchanged: Count }),
  // In path order, cut to fit one control message (truncated).
  changes: z.array(RestoreChange).max(5000),
  truncated: z.boolean(),
  // The folder has unsaved changes: they are saved as a pre-restore version
  // before anything is written.
  protection: z.strictObject({ needed: z.boolean(), unsavedChanges: Count }),
  settings: z.strictObject({
    action: z.enum(SETTINGS_ACTIONS),
    reason: z.enum(KEPT_SETTINGS_REASONS).nullable(),
  }),
  collisions: z.strictObject({ count: Count, entries: z.array(RestoreCollision).max(100) }),
  // Bytes the restore writes, and what the folder's volume has free.
  space: z.strictObject({ requiredBytes: Count, availableBytes: Count.nullable() }),
  // Draft Tide can't see other programs; these are hints, not a lock. The
  // user (or the agent, for itself) must stop tools that write to the folder.
  writers: z.strictObject({
    // A save or restore of this project is running.
    draftTideBusy: z.boolean(),
    // Files changed in the last few seconds: something may still be writing.
    recentlyModified: Excerpt,
  }),
  // Why applying would refuse as things stand (UNTRACKED_FILES,
  // INSUFFICIENT_DISK_SPACE); null when it can go ahead.
  blocked: ErrorCodeSchema.nullable(),
  // The folder already matches the version: applying changes nothing
  // (NO_CHANGES).
  noop: z.boolean(),
});
export type RestorePlan = z.infer<typeof RestorePlan>;

export const PlanApplyInput = z.strictObject({ projectId: ProjectId, planId: PlanId });

export const RestoreResult = z.strictObject({
  projectId: ProjectId,
  operationId: OperationId,
  target: CommitRef,
  // The pre-restore version, when the folder had unsaved changes.
  protection: CommitRef.nullable(),
  // The restore version: same content as the target, newest in history.
  restored: CommitRef,
  written: Count,
  deleted: Count,
});
export type RestoreResult = z.infer<typeof RestoreResult>;

//   check    reading the folder and comparing it with the plan
//   protect  saving the unsaved changes as a pre-restore version
//   apply    writing and deleting files
//   verify   reading the result back
//   publish  recording the restore version
export const RESTORE_STAGES = ['check', 'protect', 'apply', 'verify', 'publish'] as const;
export const RestoreStage = z.enum(RESTORE_STAGES);
export type RestoreStage = z.infer<typeof RestoreStage>;

export const RestoreProgress = z.strictObject({
  stage: RestoreStage,
  filesDone: Count,
  filesTotal: Count,
  bytesDone: Count,
  bytesTotal: Count,
});
export type RestoreProgress = z.infer<typeof RestoreProgress>;

// ---- Recovery (M1 plan §9.4)

//   finish    complete what the operation set out to do
//   rollback  put back what it changed; record nothing
// Either way, a file another program changed meanwhile is left as it is.
export const RECOVERY_STRATEGIES = ['finish', 'rollback'] as const;
export const RecoveryStrategy = z.enum(RECOVERY_STRATEGIES);
export type RecoveryStrategy = z.infer<typeof RecoveryStrategy>;

//   interrupted      the Engine stopped while the operation was writing
//   external-change  another program changed a file while it was written
//   history-changed  another program added to the branch before the restore
//                    was recorded
//   not-recorded     the files were written, recording the version failed
//   verify-failed    the files read back differ from what was written
//   write-failed     writing a file failed (disk full, permissions)
//   index-switch     the version is in history; switching Git's index to it
//                    didn't finish (Draft Tide's lock is still in `.git`)
//   unknown-lock     Draft Tide's lock is in `.git`, but no operation this
//                    computer recorded explains it
export const RECOVERY_REASONS = [
  'interrupted',
  'external-change',
  'history-changed',
  'not-recorded',
  'verify-failed',
  'write-failed',
  'index-switch',
  'unknown-lock',
] as const;
export const RecoveryReason = z.enum(RECOVERY_REASONS);
export type RecoveryReason = z.infer<typeof RecoveryReason>;

export const RecoveryItem = z.strictObject({
  operationId: OperationId,
  // lock: only Draft Tide's lock is left, with nothing recorded about it.
  kind: z.enum(['save', 'restore', 'lock']),
  origin: Origin.nullable(),
  state: OperationState.nullable(),
  reason: RecoveryReason,
  startedAt: IsoTimestamp.nullable(),
  target: CommitRef.nullable(),
  protection: CommitRef.nullable(),
  // For a restore that wrote files: where each file is now. done: as the
  // restore wanted; pending: still as before it; conflicts: neither.
  files: z.strictObject({ total: Count, done: Count, pending: Count, conflicts: Excerpt }).nullable(),
  strategies: z.array(RecoveryStrategy).max(2),
  // Safe to complete without asking: Draft Tide does it before the next
  // change to the project, or at its next start.
  automatic: z.boolean(),
});
export type RecoveryItem = z.infer<typeof RecoveryItem>;

export const RecoveryReport = z.strictObject({
  projectId: ProjectId,
  items: z.array(RecoveryItem).max(100),
  // `.git/index.lock`: free, Draft Tide's, or another Git's.
  lock: z.enum(['free', 'draft-tide', 'other']),
  checkedAt: IsoTimestamp,
});
export type RecoveryReport = z.infer<typeof RecoveryReport>;

export const RecoveryInspectInput = z.strictObject({ projectId: ProjectId });

export const RecoveryPlanInput = z.strictObject({
  projectId: ProjectId,
  operationId: OperationId,
  strategy: RecoveryStrategy,
});

export const RecoveryPlan = z.strictObject({
  planId: PlanId,
  projectId: ProjectId,
  operationId: OperationId,
  strategy: RecoveryStrategy,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  write: Count,
  delete: Count,
  // Already as the strategy wants them.
  unchanged: Count,
  conflicts: Excerpt,
  // finish records a version (or completes recording one); rollback doesn't.
  records: z.boolean(),
});
export type RecoveryPlan = z.infer<typeof RecoveryPlan>;

export const RecoveryResult = z.strictObject({
  // null when only Draft Tide's lock was left, with no operation recorded.
  operation: OperationStatus.nullable(),
  written: Count,
  deleted: Count,
  conflicts: Excerpt,
});
export type RecoveryResult = z.infer<typeof RecoveryResult>;
