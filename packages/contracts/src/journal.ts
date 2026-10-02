import { z } from 'zod';
import { ProjectSummary } from './engine.ts';
import { CommitRef, GitObjectId } from './history.ts';
import { OperationId, SnapshotId } from './ids.ts';
import { OperationError } from './operation.ts';
import { RelativePath } from './project-config.ts';
import { Excerpt, FolderPath, ProjectName } from './project.ts';
import { RecoveryReason, RecoveryStrategy } from './restore.ts';

// The Engine's operation journal and stored plans (TECH_STACK §6.4): the
// kind-specific part of each SQLite row, as JSON. This is local state, not a
// public DTO: it never crosses the process boundary, and it is read back
// strictly (a row that doesn't parse is STORAGE_IO_FAILED, never guessed
// around). Large lists (a restore's files) have their own table.

// A publish about to happen (M1 plan §9.3.1). Recorded before the lock is
// taken, so recovery can tell from the branch tip whether the ref moved.
//   protection  the pre-restore version of a restore
//   final       the operation's own version (a save, the restore version)
export const PublishIntent = z.strictObject({
  step: z.enum(['protection', 'final']),
  ref: z.string().min(1).max(1024),
  expectedOld: GitObjectId.nullable(),
  commit: GitObjectId,
  tree: GitObjectId,
  snapshotId: SnapshotId.nullable(),
});
export type PublishIntent = z.infer<typeof PublishIntent>;

export const SaveJournal = z.strictObject({
  kind: z.literal('save'),
  publish: PublishIntent.nullable(),
  snapshot: CommitRef.nullable(),
  error: OperationError.nullable(),
});
export type SaveJournal = z.infer<typeof SaveJournal>;

export const RestoreJournal = z.strictObject({
  kind: z.literal('restore'),
  planId: z.string().max(64),
  ref: z.string().min(1).max(1024),
  // The tip the plan was made on.
  baseTip: GitObjectId,
  target: CommitRef,
  targetTree: GitObjectId,
  // The current `.drafttide.json` blob, kept in place of the target's when
  // the target's can't serve this project.
  settingsBlob: GitObjectId.nullable(),
  // The tree the restore version records, once built.
  restoreTree: GitObjectId.nullable(),
  protection: CommitRef.nullable(),
  // The commit the restore version goes on: the protection, else the base.
  parent: GitObjectId.nullable(),
  publish: PublishIntent.nullable(),
  restored: CommitRef.nullable(),
  reason: RecoveryReason.nullable(),
  conflicts: Excerpt,
  error: OperationError.nullable(),
});
export type RestoreJournal = z.infer<typeof RestoreJournal>;

export const ConnectRequestJournal = z.strictObject({
  kind: z.literal('connect-request'),
  root: FolderPath,
  name: ProjectName.nullable(),
  entryFiles: z.array(RelativePath).max(16),
  project: ProjectSummary.nullable(),
  error: OperationError.nullable(),
});
export type ConnectRequestJournal = z.infer<typeof ConnectRequestJournal>;

export const OperationJournal = z.discriminatedUnion('kind', [SaveJournal, RestoreJournal, ConnectRequestJournal]);
export type OperationJournal = z.infer<typeof OperationJournal>;

// ---- Stored plans

export const RestorePlanRecord = z.strictObject({
  kind: z.literal('restore'),
  ref: z.string().min(1).max(1024),
  baseTip: GitObjectId,
  target: CommitRef,
  targetTree: GitObjectId,
  settingsBlob: GitObjectId.nullable(),
});
export type RestorePlanRecord = z.infer<typeof RestorePlanRecord>;

export const RecoveryPlanRecord = z.strictObject({
  kind: z.literal('recovery'),
  operationId: OperationId,
  strategy: RecoveryStrategy,
});
export type RecoveryPlanRecord = z.infer<typeof RecoveryPlanRecord>;

export const PlanRecord = z.discriminatedUnion('kind', [RestorePlanRecord, RecoveryPlanRecord]);
export type PlanRecord = z.infer<typeof PlanRecord>;
