import { z } from 'zod';
import { ProjectSummary } from './engine.ts';
import { ErrorCodeSchema } from './errors.ts';
import { CommitRef, GitObjectId, VersionInfo } from './history.ts';
import { IsoTimestamp, OperationId, PlanId, ProjectId } from './ids.ts';
import { Excerpt, FolderPath } from './project.ts';
import { BranchName, GitHubRepo, RepoRef, RemoteBinding, SyncStatus } from './remote.ts';
import { RestoreChange, RestoreCollision } from './restore.ts';

// Connecting a remote, pushing, pulling and opening a project from GitHub (M1
// plan §10.2–10.7). Pulling and opening write working files, so both are plan
// → apply, like a restore. Connecting is plan → apply too: the plan carries
// the first-push review the user confirms.

const Count = z.number().int().nonnegative();
const DisplayPath = z.string().max(4096);

// ---- Connecting a remote and the first-push review (M1 plan §10.2, §10.6)

// How the remote branch relates to the project's branch.
//   empty       the repository has nothing yet: the first push creates the
//               branch, and GitHub makes it the default
//   same        it holds exactly this history
//   ahead       the folder has versions the remote doesn't: they are pushed
//   behind      the remote has newer versions of this history (取得更新 after)
//   diverged    both have new versions (REMOTE_DIVERGED)
//   unrelated   it holds a history this folder doesn't share, such as a
//               README GitHub created (REMOTE_DIVERGED, unrelated-history)
export const REMOTE_RELATIONS = ['empty', 'same', 'ahead', 'behind', 'diverged', 'unrelated'] as const;
export const RemoteRelation = z.enum(REMOTE_RELATIONS);
export type RemoteRelation = z.infer<typeof RemoteRelation>;

// GitHub refuses files over 100 MiB and warns over 50 MiB.
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
export const GITHUB_FILE_WARNING_BYTES = 50 * 1024 * 1024;

// What a push sends that the remote doesn't have: every file of every
// version, as Git objects (M1 plan §10.6). Helps the user decide; it can't
// promise to find every secret.
export const PushReview = z.strictObject({
  commits: Count,
  // Draft Tide versions among them.
  versions: Count,
  // Distinct file contents sent, and their total size (before compression).
  files: Count,
  bytes: Count,
  largest: z.array(z.strictObject({ path: DisplayPath, size: Count })).max(10),
  // GitHub refuses these: the push would fail until they are gone from the
  // pushed history.
  overLimit: Excerpt,
  // GitHub warns about these.
  large: Excerpt,
  // Names or contents that look like keys, tokens or credentials.
  suspectedSecrets: Excerpt,
  // false when the content check stopped at its budget.
  secretsScanComplete: z.boolean(),
});
export type PushReview = z.infer<typeof PushReview>;

export const RemoteConnectPlanInput = z.strictObject({ projectId: ProjectId, repo: RepoRef });

export const RemoteConnectPlan = z.strictObject({
  planId: PlanId,
  projectId: ProjectId,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  repo: GitHubRepo,
  branch: BranchName,
  relation: RemoteRelation,
  localTip: GitObjectId.nullable(),
  remoteTip: GitObjectId.nullable(),
  // What connecting pushes; null when it pushes nothing.
  review: PushReview.nullable(),
  // The folder's `remote.origin.url` now (credentials removed), and whether
  // it already names this repository.
  origin: z.strictObject({ url: z.string().max(1000).nullable(), matches: z.boolean() }),
  // Why connecting would refuse (REMOTE_DIVERGED, REMOTE_REJECTED,
  // RECOVERY_REQUIRED…), with its reason; null when it can go ahead.
  blocked: z.strictObject({ code: ErrorCodeSchema, reason: z.string().max(64).nullable() }).nullable(),
});
export type RemoteConnectPlan = z.infer<typeof RemoteConnectPlan>;

export const RemoteConnectApplyInput = z.strictObject({
  projectId: ProjectId,
  planId: PlanId,
  // Also set the folder's `remote.origin` to this repository, for other Git
  // tools.
  setOrigin: z.boolean(),
  // The agent request this answers (remote-connect-request).
  requestId: OperationId.optional(),
});

export const PushResult = z.strictObject({
  projectId: ProjectId,
  //   pushed      the remote now has the newest commit
  //   up-to-date  it already had it
  outcome: z.enum(['pushed', 'up-to-date']),
  commit: GitObjectId,
  // Commits the remote didn't have before.
  commits: Count,
  status: SyncStatus,
});
export type PushResult = z.infer<typeof PushResult>;

export const RemoteConnectResult = z.strictObject({
  projectId: ProjectId,
  remote: RemoteBinding,
  originSet: z.boolean(),
  // The first push; null when there was nothing to push (the remote has it,
  // or is newer).
  push: PushResult.nullable(),
  status: SyncStatus,
});
export type RemoteConnectResult = z.infer<typeof RemoteConnectResult>;

// ---- Pulling: fast-forward only (M1 plan §10.4)

//   equal     both have the same newest commit
//   ahead     only the folder has new versions (push them)
//   behind    only the remote has: fast-forward
//   diverged  both have (REMOTE_DIVERGED)
//   no-remote-branch  the remote has no such branch yet
export const PULL_RELATIONS = ['equal', 'ahead', 'behind', 'diverged', 'no-remote-branch'] as const;
export const PullRelation = z.enum(PULL_RELATIONS);
export type PullRelation = z.infer<typeof PullRelation>;

export const SyncPullPlanInput = z.strictObject({ projectId: ProjectId });

export const SyncPullPlan = z.strictObject({
  planId: PlanId,
  projectId: ProjectId,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  branch: BranchName,
  relation: PullRelation,
  base: VersionInfo.nullable(),
  // The remote's newest commit (behind), else null.
  target: VersionInfo.nullable(),
  // Commits that come in.
  incoming: Count,
  summary: z.strictObject({ overwrite: Count, add: Count, delete: Count, unchanged: Count }),
  changes: z.array(RestoreChange).max(5000),
  truncated: z.boolean(),
  // A pull needs a folder without unsaved changes: save them first.
  unsavedChanges: Count,
  collisions: z.strictObject({ count: Count, entries: z.array(RestoreCollision).max(100) }),
  space: z.strictObject({ requiredBytes: Count, availableBytes: Count.nullable() }),
  // Why applying would refuse (UNSAVED_CHANGES, UNTRACKED_FILES,
  // REMOTE_DIVERGED, RECOVERY_REQUIRED, INSUFFICIENT_DISK_SPACE,
  // UNSUPPORTED_ENTRY, CONFIG_INVALID), with its reason; null when it can go
  // ahead.
  blocked: z.strictObject({ code: ErrorCodeSchema, reason: z.string().max(64).nullable() }).nullable(),
  // Nothing to get: applying changes nothing (NO_CHANGES).
  noop: z.boolean(),
});
export type SyncPullPlan = z.infer<typeof SyncPullPlan>;

export const SyncPullResult = z.strictObject({
  projectId: ProjectId,
  operationId: OperationId,
  from: CommitRef,
  to: CommitRef,
  written: Count,
  deleted: Count,
});
export type SyncPullResult = z.infer<typeof SyncPullResult>;

// ---- Opening a project from GitHub (M1 plan §10.7)

export const RemoteOpenPlanInput = z.strictObject({
  repo: RepoRef,
  // Must not exist (its parent must) or be an empty folder.
  destination: FolderPath,
});

export const RemoteOpenPlan = z.strictObject({
  planId: PlanId,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  repo: GitHubRepo,
  branch: BranchName,
  // The commit that is opened; null when the repository is empty.
  tip: GitObjectId.nullable(),
  destination: z.strictObject({ path: DisplayPath, exists: z.boolean() }),
  // Why applying would refuse (UNTRACKED_FILES for a folder that isn't
  // empty, REMOTE_REJECTED for an empty repository…); null when it can.
  blocked: z.strictObject({ code: ErrorCodeSchema, reason: z.string().max(64).nullable() }).nullable(),
});
export type RemoteOpenPlan = z.infer<typeof RemoteOpenPlan>;

export const RemoteOpenApplyInput = z.strictObject({ planId: PlanId });

export const RemoteOpenResult = z.strictObject({
  project: ProjectSummary,
  operationId: OperationId,
  tip: CommitRef,
  files: Count,
  // The project was connected to another folder that is gone; it now uses
  // this one.
  relinked: z.boolean(),
});
export type RemoteOpenResult = z.infer<typeof RemoteOpenResult>;

//   fetch    getting the versions from GitHub
//   check    checking what came
//   apply    writing files
//   verify   reading them back
//   publish  moving the branch and Git's index
//   push     sending versions to GitHub
export const SYNC_STAGES = ['fetch', 'check', 'apply', 'verify', 'publish', 'push'] as const;
export const SyncStage = z.enum(SYNC_STAGES);
export type SyncStage = z.infer<typeof SyncStage>;

export const SyncProgress = z.strictObject({
  stage: SyncStage,
  filesDone: Count,
  filesTotal: Count,
  bytesDone: Count,
  bytesTotal: Count,
});
export type SyncProgress = z.infer<typeof SyncProgress>;
