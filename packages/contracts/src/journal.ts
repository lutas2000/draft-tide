import { z } from 'zod';
import { ProjectSummary } from './engine.ts';
import { CommitRef, GitObjectId } from './history.ts';
import { OperationId, SnapshotId } from './ids.ts';
import { OperationError } from './operation.ts';
import { RelativePath } from './project-config.ts';
import { Excerpt, FolderPath, ProjectName } from './project.ts';
import { BranchName, GitHubRepo, GitHubUser, RemoteBinding, RepoRef } from './remote.ts';
import { PullRelation } from './sync.ts';
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

// A fast-forward to the remote's newer commit (M1 plan §10.4): the folder's
// files move from the base tip's tree to the target's, then the branch moves
// to the target (no new commit). Recovery finishes or rolls back like a
// restore's.
export const PullJournal = z.strictObject({
  kind: z.literal('pull'),
  planId: z.string().max(64),
  ref: z.string().min(1).max(1024),
  remote: RepoRef,
  // The branch's tip before: the files move from its tree.
  base: CommitRef,
  target: CommitRef,
  targetTree: GitObjectId,
  publish: PublishIntent.nullable(),
  reason: RecoveryReason.nullable(),
  conflicts: Excerpt,
  error: OperationError.nullable(),
});
export type PullJournal = z.infer<typeof PullJournal>;

// Opening a project from GitHub (M1 plan §10.7): a new repo in an empty
// folder, the remote's files written into it, then its branch created. The
// project is connected before the first file is written, so an interrupted
// open shows up on the project's recovery card.
export const OpenJournal = z.strictObject({
  kind: z.literal('open'),
  planId: z.string().max(64),
  ref: z.string().min(1).max(1024),
  remote: RepoRef,
  root: FolderPath,
  // Undoing an open that stopped before its first file: the folder it
  // created (removed again), and the folder the project used before when it
  // was relinked (put back).
  createdFolder: z.boolean(),
  relinkedFrom: FolderPath.nullable(),
  target: CommitRef,
  targetTree: GitObjectId,
  project: ProjectSummary.nullable(),
  publish: PublishIntent.nullable(),
  reason: RecoveryReason.nullable(),
  conflicts: Excerpt,
  error: OperationError.nullable(),
});
export type OpenJournal = z.infer<typeof OpenJournal>;

export const LoginRequestJournal = z.strictObject({
  kind: z.literal('login-request'),
  user: GitHubUser.nullable(),
  error: OperationError.nullable(),
});
export type LoginRequestJournal = z.infer<typeof LoginRequestJournal>;

export const RemoteConnectRequestJournal = z.strictObject({
  kind: z.literal('remote-connect-request'),
  remote: RemoteBinding.nullable(),
  error: OperationError.nullable(),
});
export type RemoteConnectRequestJournal = z.infer<typeof RemoteConnectRequestJournal>;

export const OperationJournal = z.discriminatedUnion('kind', [
  SaveJournal,
  RestoreJournal,
  PullJournal,
  OpenJournal,
  ConnectRequestJournal,
  LoginRequestJournal,
  RemoteConnectRequestJournal,
]);
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

// Connecting a remote: what the plan saw on both sides, re-checked by the
// apply (PLAN_STALE when either moved).
export const RemoteConnectPlanRecord = z.strictObject({
  kind: z.literal('remote-connect'),
  repo: GitHubRepo,
  branch: BranchName,
  localTip: GitObjectId.nullable(),
  remoteTip: GitObjectId.nullable(),
});
export type RemoteConnectPlanRecord = z.infer<typeof RemoteConnectPlanRecord>;

export const PullPlanRecord = z.strictObject({
  kind: z.literal('pull'),
  ref: z.string().min(1).max(1024),
  remote: RepoRef,
  // Only behind is applied; the others answer NO_CHANGES or REMOTE_DIVERGED.
  relation: PullRelation,
  base: CommitRef,
  target: CommitRef,
  targetTree: GitObjectId,
});
export type PullPlanRecord = z.infer<typeof PullPlanRecord>;

// Opening from GitHub has no project yet: the plan's row has none.
export const OpenPlanRecord = z.strictObject({
  kind: z.literal('open'),
  repo: GitHubRepo,
  branch: BranchName,
  tip: GitObjectId,
  // The canonical path, and whether the folder existed (empty) when planned.
  destination: FolderPath,
  existed: z.boolean(),
});
export type OpenPlanRecord = z.infer<typeof OpenPlanRecord>;

export const PlanRecord = z.discriminatedUnion('kind', [
  RestorePlanRecord,
  RecoveryPlanRecord,
  RemoteConnectPlanRecord,
  PullPlanRecord,
  OpenPlanRecord,
]);
export type PlanRecord = z.infer<typeof PlanRecord>;
