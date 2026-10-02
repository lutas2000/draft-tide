import type {
  AgentAccess,
  CommitIdentity,
  DesktopIdentityMode,
  EngineEvent,
  EngineInstanceId,
  GitHubLinks,
  GitHubRepo,
  GitHubUser,
  IsoTimestamp,
  OperationId,
  OperationJournal,
  OperationKind,
  OperationState,
  Origin,
  PlanId,
  PlanRecord,
  PreviewBlocked,
  PreviewEnvironment,
  PreviewImageKind,
  PreviewRecord,
  PreviewSettings,
  PreviewSubject,
  ProjectConfig,
  ProjectId,
  ProjectSummary,
  RemoteBinding,
  RemoteRepoList,
  RepoBlocker,
  RepoRef,
  RepoWarning,
  SyncError,
} from '@draft-tide/contracts';

// What core needs from the outside. The Engine's composition root provides
// real implementations (local-store, git-backend, adapter-filesystem,
// remote-github, the Node runtime); tests may provide their own.

export interface Clock {
  nowIso(): IsoTimestamp;
}

// SQLite-backed local state (TECH_STACK §6.1). Not a cache: losing it must
// never be guessed around.
export interface LocalStore {
  readonly storageSchemaVersion: number;
  readonly sqliteVersion: string;
  // Missing or unreadable means off.
  getAgentAccess(): AgentAccess;
  setAgentAccess(enabled: boolean, at: IsoTimestamp): AgentAccess;
  // Bindings: one canonical root per project, one project per root.
  listProjects(): ProjectSummary[];
  getProject(projectId: ProjectId): ProjectSummary | null;
  findProjectByRoot(root: string): ProjectSummary | null;
  insertProject(project: ProjectSummary): void;
  updateProject(projectId: ProjectId, changes: { root?: string; name?: string }): void;
  // Only to undo an open from GitHub that failed before writing a file.
  deleteProject(projectId: ProjectId): void;

  // The operation journal (TECH_STACK §6.4). Rows are written before the
  // step they describe, so recovery never has to guess.
  insertOperation(op: OperationRecord): void;
  // Compare-and-set: changes the row only while its state is one of
  // `expect`, and says whether it did.
  updateOperation(
    operationId: OperationId,
    expect: readonly OperationState[],
    change: { state: OperationState; journal: OperationJournal; at: IsoTimestamp },
  ): boolean;
  getOperation(operationId: OperationId): OperationRecord | null;
  listOperations(query: OperationQuery): OperationRecord[];
  acknowledgeOperation(operationId: OperationId): void;
  // A restore's planned file changes, written in one transaction.
  insertOperationFiles(operationId: OperationId, files: readonly OperationFile[]): void;
  listOperationFiles(operationId: OperationId): OperationFile[];
  markOperationFile(operationId: OperationId, seq: number, done: boolean): void;
  // Plans wait for their apply here.
  insertPlan(plan: StoredPlan): void;
  getPlan(planId: PlanId): StoredPlan | null;
  // Consumes the plan and, in the same transaction, inserts the operation it
  // starts (when given). false when the plan was already used.
  consumePlan(planId: PlanId, by: OperationId, at: IsoTimestamp, start?: OperationRecord): boolean;
  // Ended operations and plans older than this go; unfinished ones never do.
  prune(before: IsoTimestamp): void;

  // This data store's own id (created once): names its keychain item, so two
  // data stores never share a sign-in (M1-07).
  storeId(): string;

  // Remote bindings and the push queue (M1 plan §10.2–10.3). A binding is
  // local state: the repository is the user's, the folder's `remote.origin`
  // is only a courtesy to other Git tools.
  getRemote(projectId: ProjectId): StoredRemote | null;
  listRemotes(): StoredRemote[];
  putRemote(projectId: ProjectId, remote: RemoteBinding): void;
  // Removes the binding and its queued push.
  deleteRemote(projectId: ProjectId): void;
  // What the last fetch or push saw, and the last failure (null clears it).
  updateRemoteState(projectId: ProjectId, change: RemoteStateChange): void;
  // A push is wanted; requesting again keeps the earliest request.
  queuePush(projectId: ProjectId, at: IsoTimestamp): void;
  getQueuedPush(projectId: ProjectId): QueuedPush | null;
  listQueuedPushes(): QueuedPush[];
  // After a failed attempt: when to try again (null: wait for the user).
  deferPush(projectId: ProjectId, attempts: number, nextAttemptAt: IsoTimestamp | null): void;
  dequeuePush(projectId: ProjectId): void;

  // The preview cache's index (TECH_STACK §6.1: an explicit cache table,
  // rebuildable from Git and the render settings). A row that can't be read
  // back is dropped and reported as absent: it is a cache, not state.
  getPreview(projectId: ProjectId, key: string): StoredPreview | null;
  // Inserts or replaces.
  putPreview(entry: StoredPreview): void;
  touchPreview(projectId: ProjectId, key: string, at: IsoTimestamp): void;
  deletePreview(projectId: ProjectId, key: string): void;
  // Every cached preview, least recently used first.
  listPreviews(): PreviewCacheEntry[];
}

export interface StoredRemote {
  projectId: ProjectId;
  remote: RemoteBinding;
  // The remote branch's commit as last fetched or pushed.
  remoteTip: GitOid | null;
  lastCheckAt: IsoTimestamp | null;
  lastPushAt: IsoTimestamp | null;
  lastError: SyncError | null;
}

export interface RemoteStateChange {
  remoteTip?: GitOid | null;
  lastCheckAt?: IsoTimestamp;
  lastPushAt?: IsoTimestamp;
  lastError?: SyncError | null;
}

export interface QueuedPush {
  projectId: ProjectId;
  requestedAt: IsoTimestamp;
  attempts: number;
  // null: waiting for the user (sign in, resolve divergence).
  nextAttemptAt: IsoTimestamp | null;
}

export interface PreviewCacheEntry {
  projectId: ProjectId;
  key: string;
  usedAt: IsoTimestamp;
  // Both PNGs.
  bytes: number;
}

export interface StoredPreview extends PreviewCacheEntry {
  createdAt: IsoTimestamp;
  record: PreviewRecord;
}

export interface OperationRecord {
  operationId: OperationId;
  projectId: ProjectId | null;
  kind: OperationKind;
  origin: Origin;
  state: OperationState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  // The user dismissed its notice in the app.
  acknowledged: boolean;
  journal: OperationJournal;
}

export interface OperationQuery {
  projectId?: ProjectId;
  kinds?: readonly OperationKind[];
  states?: readonly OperationState[];
  // Only rows whose notice the user hasn't dismissed.
  unacknowledged?: boolean;
  newestFirst?: boolean;
  limit?: number;
}

// One file a restore changes: its content before and after (null: absent).
export interface FileState {
  oid: GitOid;
  mode: GitBlobMode;
}

export interface OperationFile {
  seq: number;
  path: string;
  before: FileState | null;
  after: FileState | null;
  // Written as planned (progress only: recovery reads the folder itself).
  done: boolean;
}

export interface StoredPlan {
  planId: PlanId;
  // null for opening a project from GitHub: it has no project yet.
  projectId: ProjectId | null;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  fingerprint: string;
  record: PlanRecord;
  consumedBy: OperationId | null;
}

// Pushes events to connected desktop sessions.
export interface EventSink {
  publish(event: EngineEvent): void;
}

// Facts about this Engine process, fixed at start.
export interface EngineIdentity {
  instanceId: EngineInstanceId;
  appVersion: string;
  startedAt: IsoTimestamp;
  desktopIdentity: DesktopIdentityMode;
  runtime: { node: string; platform: string; arch: string };
}

export interface CorePorts {
  clock: Clock;
  store: LocalStore;
  events: EventSink;
  identity: EngineIdentity;
  host: ProjectHost;
  // Without them previews answer PREVIEW_FAILED (no-renderer).
  previews?: PreviewPorts;
  // Without it sign-in is unavailable and projects can't be synced.
  remote?: RemoteProvider;
}

// ---- GitHub (M1 plan §10, implemented by @draft-tide/remote-github)
//
// The provider owns sign-in and the token. Core never sees a token: it gets
// repositories, the account, and for each Git network operation a GitAccess
// whose credential only git-backend reads.

export type AccountState = { state: 'signed-out' } | { state: 'signed-in' | 'expired'; user: GitHubUser };

export interface DeviceLogin {
  // Names this login to pollLogin; opaque to core.
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresAt: IsoTimestamp;
  intervalMs: number;
}

// pending: ask again after intervalMs (GitHub's slow_down raises it).
// Failures to reach GitHub throw (NETWORK_UNAVAILABLE).
export type LoginPoll =
  | { status: 'pending'; intervalMs: number }
  | { status: 'completed'; user: GitHubUser }
  | { status: 'expired' }
  | { status: 'denied' };

// One Git network operation's credential. Only git-backend reveals it, into
// the operation's 0600 askpass file.
export interface GitCredential {
  readonly username: string;
  reveal(): string;
}

export interface GitAccess {
  // The repository's address, built from its owner and name by the provider.
  url: string;
  credential: GitCredential | null;
  // Plain http: only the development builds' test GitHub on loopback.
  allowHttp: boolean;
}

export interface RemoteProvider {
  // Why this build or computer can't sign in; null when it can.
  readonly unavailable: 'no-client-id' | 'no-keychain' | null;
  readonly links: GitHubLinks | null;
  // From the keychain; never the network.
  account(): Promise<AccountState>;
  beginLogin(signal?: AbortSignal): Promise<DeviceLogin>;
  pollLogin(handle: string, signal?: AbortSignal): Promise<LoginPoll>;
  forgetLogin(handle: string): void;
  // Removes the token from the keychain.
  signOut(): Promise<void>;
  // The repositories the app is installed on that the user can reach
  // (AUTH_REQUIRED when signed out or expired).
  listRepos(signal?: AbortSignal): Promise<RemoteRepoList>;
  // One repository, which must be among them (REMOTE_REJECTED
  // app-not-installed otherwise): only the user's own synced repositories can
  // be connected or opened. For push the user's role must allow pushing too
  // (REMOTE_REJECTED no-push-access).
  getRepo(ref: RepoRef, purpose: 'push' | 'open', signal?: AbortSignal): Promise<GitHubRepo>;
  // A credential for one Git network operation on this repository, refreshed
  // first when it is about to expire (never during the operation). refused:
  // Git just refused this access's token; it is refreshed if it is still the
  // current one (AUTH_REQUIRED expired when that fails).
  gitAccess(ref: RepoRef, signal?: AbortSignal, refused?: GitAccess): Promise<GitAccess>;
}

// ---- Previews (M1 plan §8, TECH_STACK §10)

export interface PreviewPorts {
  renderer: PreviewRenderer;
  images: PreviewImageStore;
  // The time zone pages see (IANA name): the computer's own, recorded and
  // part of every cache key.
  timezone: string;
}

// The Preview Host supervisor (implemented by the Engine's composition root).
// It runs one render at a time per call; core queues and deduplicates.
export interface PreviewRenderer {
  // What renders (Electron and Chromium versions), part of every cache key;
  // null when this Engine has no Preview Host.
  readonly rendererId: string | null;
  // Renders and captures. Every file the page asks for comes from `files`;
  // the host is given nothing else. PREVIEW_FAILED (with a reason) when no
  // image comes back; the signal stops the render and its host.
  render(job: RenderJob, files: PreviewFileSource, signal: AbortSignal): Promise<RenderOutput>;
}

export interface RenderJob {
  jobId: string;
  // A host serves the jobs of one project only.
  projectId: ProjectId;
  subject: PreviewSubject;
  settings: PreviewSettings;
  // Exactly the sizes the PNGs must have.
  output: { width: number; height: number };
  thumbnail: { width: number; height: number };
  timeoutMs: number;
}

export type ServedFile = { status: 'ok'; contentType: string; bytes: Uint8Array } | { status: 'missing' };

// What a render's page may read: the files of one version, decided by core.
export interface PreviewFileSource {
  // `path` is the URL pathname the page asked for, still percent-encoded.
  read(path: string): Promise<ServedFile>;
}

export interface CapturedImage {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface RenderOutput {
  full: CapturedImage;
  thumbnail: CapturedImage;
  // Raw targets, as the host saw them; core makes them printable.
  blocked: PreviewBlocked;
  environment: PreviewEnvironment;
}

// The PNG files of cached previews (<data>/projects/<id>/cache/previews/).
export interface PreviewImageStore {
  write(projectId: ProjectId, key: string, image: PreviewImageKind, png: Uint8Array): Promise<void>;
  // Up to `length` bytes from `offset`; null when the file is gone.
  read(
    projectId: ProjectId,
    key: string,
    image: PreviewImageKind,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
  // Whether both PNGs are there.
  has(projectId: ProjectId, key: string): Promise<boolean>;
  remove(projectId: ProjectId, key: string): Promise<void>;
  // Removes every cached PNG except those of the previews named here, as
  // `<project-id>/<key>` (files a crash left without an index row go too).
  removeAllExcept(keep: ReadonlySet<string>): Promise<void>;
}

// Development and test builds only: named points inside long operations where
// a test pauses, changes the folder or kills the Engine. Release builds pass
// none.
export interface TestHooks {
  checkpoint?(point: string, detail?: { path?: string; index?: number }): void | Promise<void>;
}

// Opens what a project use case needs for one folder (implemented by the
// Engine's composition root with git-backend and adapter-filesystem).
export interface ProjectHost {
  // The folder's canonical (real) path. INVALID_ARGUMENT for a relative path,
  // LOCAL_ROOT_UNAVAILABLE when it is not a folder, REPO_UNSUPPORTED
  // (overlaps-app-data) when it overlaps Draft Tide's data directory.
  canonicalRoot(path: string): Promise<string>;
  openRepo(root: string): ProjectGit;
  // Lists a folder that has no `.git` yet through a scratch git dir in the
  // data directory; nothing is written into the folder. dispose removes it.
  openListingRepo(root: string): Promise<{ repo: GitRepo; dispose(): Promise<void> }>;
  openWorkspace(root: string): Workspace;
  createStaging(projectId: ProjectId, operationId: OperationId): Promise<StagingArea>;
  // Removes what operations of this project left in the data directory,
  // except for the ones named.
  clearOperationData(projectId: ProjectId, keep: ReadonlySet<OperationId>): Promise<void>;
  // The remote's branches and their commits (`ls-remote`), without a project
  // repo (opening from GitHub).
  remoteHeads(access: GitAccess, signal?: AbortSignal): Promise<Map<string, GitOid>>;
  // Whether a folder exists, and if so whether it is empty. For opening from
  // GitHub: the folder must be absent (with an existing parent) or empty.
  // INVALID_ARGUMENT for a relative path, LOCAL_ROOT_UNAVAILABLE without a
  // parent folder, REPO_UNSUPPORTED (overlaps-app-data).
  inspectDestination(path: string): Promise<{ path: string; exists: boolean; empty: boolean }>;
  // Creates the folder (0755) if it doesn't exist; refuses one that isn't
  // empty (UNTRACKED_FILES). Returns its canonical path and whether it was
  // created.
  prepareDestination(path: string): Promise<{ root: string; created: boolean }>;
  // Undoes an open that failed before its first file: removes the `.git` it
  // created (only while the folder holds nothing else), and the folder itself
  // when it created that too and it is empty.
  removeFreshRepo(root: string, removeFolder: boolean): Promise<void>;
}

// ---- Git: the project's own repo (implemented by @draft-tide/git-backend)
//
// Named, read-only operations for scope and capture. Paths are
// project-relative with `/` separators, exactly as Git reports them.

// A Git object id. SHA-256 repositories are refused, so always 40 hex chars.
export type GitOid = string;
export type GitBlobMode = '100644' | '100755';

export interface IndexEntry {
  path: string;
  // As Git reports it: 100644, 100755, 120000 (symlink), 160000 (gitlink).
  mode: string;
  oid: GitOid;
  // Non-zero while a merge conflict is unresolved.
  stage: number;
  // The index no longer describes the working file.
  flag: 'skip-worktree' | 'assume-unchanged' | null;
}

// Values as `git check-attr` prints them: unspecified, set, unset or a value.
export interface PathAttributes {
  filter: string;
  text: string;
  eol: string;
  ident: string;
  workingTreeEncoding: string;
}

// Directory names and file patterns for Git's own matcher. They only keep
// untracked files out.
export interface ExcludeRules {
  dirNames: readonly string[];
  filePatterns: readonly string[];
}

// Names Git returned that are not valid UTF-8, shown lossily. They can't be
// saved and are reported, never skipped.
export interface GitListing<T> {
  entries: T[];
  nonUtf8: string[];
}

export interface RepoProbe {
  // false: a plain folder that would be `git init`ed when it is bound.
  hasRepo: boolean;
  headRef: string | null;
  branch: string | null;
  // null when there is no repo or the branch has no commit yet (unborn).
  tip: GitOid | null;
  // false where the filesystem has no executable bit (Windows) or the repo
  // says so (core.fileMode=false): modes then come from the index, as in Git.
  trustExecutableBit: boolean;
  blockers: RepoBlocker[];
  warnings: RepoWarning[];
}

export interface GitRepo {
  readonly root: string;
  probe(signal?: AbortSignal): Promise<RepoProbe>;
  listIndex(signal?: AbortSignal): Promise<GitListing<IndexEntry>>;
  // Untracked, not ignored (.gitignore, info/exclude) and not excluded by the
  // rules. A nested repository shows up in nestedRepos, never as files.
  listUntracked(
    rules: ExcludeRules,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; nestedRepos: string[]; nonUtf8: string[] }>;
  // Untracked entries that are excluded, collapsed to directories where Git
  // can. With standard: false only the rules apply (not .gitignore).
  listExcluded(rules: ExcludeRules, options: { standard: boolean }, signal?: AbortSignal): Promise<GitListing<string>>;
  // Reads .gitattributes only; never runs a filter.
  checkAttributes(paths: readonly string[], signal?: AbortSignal): Promise<Map<string, PathAttributes>>;
  // The subset of these blob ids already in the object store.
  existingBlobs(oids: readonly GitOid[], signal?: AbortSignal): Promise<Set<GitOid>>;
}

// ---- Git: objects, the index and the branch ref (implemented by @draft-tide/git-backend)
//
// Writing a version (M1 plan §7.1 steps 6–8) and reading history back. Only
// these named operations exist: no revision expressions, no passthrough. Ids
// are full 40-character object ids, checked before they reach Git.

export interface TreeEntryInput {
  path: string;
  mode: GitBlobMode;
  oid: GitOid;
}

export interface GitPerson {
  name: string;
  email: string;
  // Seconds since the epoch, and the offset as Git records it (+0800).
  time: number;
  offset: string;
}

export interface GitCommit {
  oid: GitOid;
  tree: GitOid;
  parents: GitOid[];
  author: GitPerson;
  committer: GitPerson;
  // UTF-8, lossily decoded. Cut short when the commit object is very large
  // (truncated); Draft Tide's own commits are always small.
  message: string;
  truncated: boolean;
}

// What `ls-tree -r` reports: blobs (files, and symlinks as 120000) and
// gitlinks (commit). Sizes are known for blobs only.
export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  oid: GitOid;
  size: number | null;
}

// `.git/index.lock`: free, held by a Draft Tide operation (its content names
// the operation), or held by some other Git.
export type IndexLockState =
  { held: false } | { held: true; by: 'draft-tide'; operationId: OperationId } | { held: true; by: 'other' };

// The lock-first switch of ref and index (M1 plan §9.3.1). The index for the
// new tree was prepared under the same operation id.
export interface PublishRequest {
  operationId: OperationId;
  // refs/heads/<branch>, the branch HEAD points at.
  ref: string;
  // Compare-and-swap: the tip the version was built on (null: unborn branch).
  expectedOld: GitOid | null;
  commit: GitOid;
  reflogMessage: string;
  // How long to wait for another Git to release `.git/index.lock` before
  // failing with LOCKED. Git itself doesn't wait; a short wait rides out an
  // editor's background `git status`.
  lockWaitMs?: number;
}

export interface GitHistory {
  // `git init` for a plain folder: empty template (no hooks), branch `main`
  // unless given.
  init(signal?: AbortSignal, options?: { branch?: string }): Promise<void>;

  // Writes these files' bytes as blobs, unfiltered, in order. onWritten
  // reports each one as Git finishes it.
  writeBlobs(files: readonly string[], onWritten?: (index: number) => void, signal?: AbortSignal): Promise<GitOid[]>;
  // Builds the operation's temporary index (inside `.git`, next to the real
  // one) holding exactly these entries, and writes its tree. Refuses entries
  // whose objects are missing, and paths Git would drop.
  prepareIndex(operationId: OperationId, entries: readonly TreeEntryInput[], signal?: AbortSignal): Promise<GitOid>;
  // The same for an existing tree (restore and recovery).
  prepareIndexFromTree(operationId: OperationId, tree: GitOid, signal?: AbortSignal): Promise<void>;
  discardPreparedIndex(operationId: OperationId): Promise<void>;
  createCommit(
    input: { tree: GitOid; parents: readonly GitOid[]; message: string; identity: CommitIdentity; time: IsoTimestamp },
    signal?: AbortSignal,
  ): Promise<GitOid>;
  // Takes `.git/index.lock` (LOCKED if another Git holds it), moves the ref
  // with compare-and-swap (HISTORY_CHANGED if it moved), renames the prepared
  // index in and releases the lock. Before the ref moves, a failure undoes
  // everything; after it, the lock stays and RECOVERY_REQUIRED is thrown.
  publish(request: PublishRequest): Promise<void>;
  // Completes a publish whose ref already moved: renames the prepared index in
  // (if it is still there) and releases this operation's lock. Only for a
  // branch whose tip is still that operation's commit.
  finishPublish(operationId: OperationId): Promise<void>;
  indexLock(): Promise<IndexLockState>;
  // Releases `.git/index.lock` only if this operation holds it.
  releaseIndexLock(operationId: OperationId): Promise<void>;
  // Operations whose prepared index (`index.dt-<id>`) is in `.git`.
  preparedIndexes(): Promise<OperationId[]>;
  readRef(ref: string, signal?: AbortSignal): Promise<GitOid | null>;

  readCommits(oids: readonly GitOid[], signal?: AbortSignal): Promise<GitCommit[]>;
  // The first-parent line from tip, newest first.
  firstParentLine(tip: GitOid, page: { skip: number; limit: number }, signal?: AbortSignal): Promise<GitOid[]>;
  // Every file of a tree (or a commit's tree), recursively, in Git order.
  listTree(treeish: GitOid, signal?: AbortSignal): Promise<GitListing<GitTreeEntry>>;
  lookupPath(tree: GitOid, path: string, signal?: AbortSignal): Promise<GitTreeEntry | null>;
  // The raw bytes of a blob, streamed; ending the iteration early stops Git.
  streamBlob(oid: GitOid, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  isAncestor(ancestor: GitOid, descendant: GitOid, signal?: AbortSignal): Promise<boolean>;
}

// ---- Git: the network (M1 plan §10.3–10.5, implemented by @draft-tide/git-backend)
//
// Every network operation runs in an ephemeral empty git dir that borrows the
// project's object store, so nothing in the repo's own config (insteadOf,
// proxies, credential helpers, extra headers) can redirect it or see the
// token. Only refs/remotes/draft-tide/* and objects are written here.

export interface PushObject {
  oid: GitOid;
  type: 'commit' | 'tree' | 'blob' | 'tag';
  // A path the object appears at (blobs and trees), as Git names it.
  path: string | null;
  size: number;
}

export interface GitRemote {
  // The remote's branches and their commits.
  remoteHeads(access: GitAccess, signal?: AbortSignal): Promise<Map<string, GitOid>>;
  // Fetches refs/heads/<branch> into refs/remotes/draft-tide/<branch>.
  // Returns its commit; null when the remote has no such branch.
  fetchBranch(
    access: GitAccess,
    branch: string,
    options?: { signal?: AbortSignal; haves?: readonly GitOid[] },
  ): Promise<GitOid | null>;
  // Pushes commit to refs/heads/<branch>, fast-forward only (no `+`, no
  // force), then records it in the tracking ref. REMOTE_DIVERGED when the
  // remote has commits this one doesn't contain, REMOTE_REJECTED when it
  // refuses (with a reason), AUTH_REQUIRED, NETWORK_UNAVAILABLE.
  pushBranch(access: GitAccess, branch: string, commit: GitOid, signal?: AbortSignal): Promise<{ created: boolean }>;
  // refs/remotes/draft-tide/<branch>, or null.
  trackingTip(branch: string): Promise<GitOid | null>;
  // Forgets it (connecting another repository, disconnecting). A fetch that
  // finds no such branch forgets it too.
  clearTracking(branch: string): Promise<void>;
  // Objects reachable from tip and not from any of exclude: what a push sends.
  objectsToPush(tip: GitOid, exclude: readonly GitOid[], signal?: AbortSignal): Promise<PushObject[]>;
  // Commits reachable from tip and not from any of exclude, newest first.
  commitsBetween(tip: GitOid, exclude: readonly GitOid[], signal?: AbortSignal): Promise<GitOid[]>;
  // A common ancestor of two commits, or null when their histories are
  // unrelated.
  mergeBase(a: GitOid, b: GitOid, signal?: AbortSignal): Promise<GitOid | null>;
  // `remote.origin.url` from the repo's own config file (never followed).
  readOrigin(): Promise<string | null>;
  // Sets `remote.origin.url` and its fetch refspec, for other Git tools. The
  // address of a GitAccess (https, or the test GitHub's loopback http).
  setOrigin(url: string): Promise<void>;
}

// The design repo, as git-backend opens it.
export type ProjectGit = GitRepo & GitHistory & GitRemote;

// ---- Filesystem: the bound folder (implemented by @draft-tide/adapter-filesystem)

// Enough to notice that a path now names another file, or that a file changed
// while it was read.
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export type PathInspection =
  | { kind: 'file'; size: number; executable: boolean; identity: FileIdentity }
  // Gone, or a directory now (Git treats that as a deletion too).
  | { kind: 'missing' }
  | { kind: 'unsupported'; reason: 'symlink' | 'special' | 'parent-not-directory' | 'unreadable' };

export interface FileDigest {
  oid: GitOid;
  size: number;
  executable: boolean;
  hasCR: boolean;
}

// changed: the path names another file now, or the file changed while it was
// read. Not an error: capture retries.
export type DigestResult = { changed: false; digest: FileDigest } | { changed: true };

export interface ProjectConfigRead {
  config: ProjectConfig;
  // Git blob id of the exact bytes parsed.
  oid: GitOid;
}

export interface VolumeSpace {
  // Opaque; equal ids mean the same volume.
  volume: string;
  availableBytes: number;
}

export interface Workspace {
  // Canonical (real) path of the bound folder.
  readonly root: string;
  // null when there is no `.drafttide.json`. Anything unsafe is CONFIG_INVALID.
  readProjectConfig(): Promise<ProjectConfigRead | null>;
  // lstat that never looks through a symlinked or non-directory parent.
  inspect(paths: readonly string[], signal?: AbortSignal): Promise<PathInspection[]>;
  // Streams the file; never follows a symlink.
  hash(path: string, expected: FileIdentity, signal?: AbortSignal): Promise<DigestResult>;
  // Streams the file into a new, read-only staging file at dest.
  stage(path: string, expected: FileIdentity, dest: string, signal?: AbortSignal): Promise<DigestResult>;
  // The volume new Git objects are written to.
  projectSpace(): Promise<VolumeSpace>;
  // Replaces `.drafttide.json` with these bytes, atomically and only if the
  // file is still what was reviewed: the blob id of its bytes, or null when
  // it must not exist. Anything else is SCOPE_CHANGED and nothing is written.
  writeProjectConfig(bytes: Uint8Array, expected: GitOid | null): Promise<void>;

  // ---- Write-back (restore and recovery, M1 plan §9.3 step 6)
  //
  // One file at a time, each only if the path still holds what the operation
  // expects (content id, or null for nothing there). The new bytes go into an
  // exclusive temporary file in the same folder, are flushed, and replace the
  // file by rename; parents are real folders, created as needed, never
  // links. `changed` means the expectation failed and nothing was written.
  // The bytes must have the blob id `oid` (checked before they replace
  // anything).
  writeFile(
    path: string,
    content: AsyncIterable<Uint8Array>,
    options: { mode: GitBlobMode; expected: GitOid | null; oid: GitOid },
    signal?: AbortSignal,
  ): Promise<WriteOutcome>;
  // Removes the file only if it still has this content, then any parent
  // folders that are left empty.
  removeFile(path: string, expected: GitOid, signal?: AbortSignal): Promise<WriteOutcome>;
  // What is at each path, without following links or checking parents.
  occupants(paths: readonly string[]): Promise<Occupant[]>;
  // Whether each path exists spelled exactly so, every segment included. On a
  // case- or normalization-insensitive filesystem, lstat finds `Logo.png` for
  // `logo.png`; this doesn't.
  exactNames(paths: readonly string[]): Promise<boolean[]>;
  // Everything inside a folder, recursively (at most `max` entries).
  listFolder(path: string, max: number): Promise<{ entries: string[]; complete: boolean }>;
}

export type WriteOutcome = { changed: false } | { changed: true };

export type Occupant = 'missing' | 'file' | 'folder' | 'link' | 'other';

// Immutable staging for one operation, outside the project folder
// (<data>/projects/<project-id>/operations/<operation-id>/).
export interface StagingArea {
  readonly dir: string;
  prepareAttempt(attempt: number): Promise<void>;
  // Where the bytes of one blob are staged in an attempt.
  pathFor(attempt: number, oid: GitOid): string;
  discardAttempt(attempt: number): Promise<void>;
  space(): Promise<VolumeSpace>;
  // Removes everything. Only once the operation no longer needs it.
  remove(): Promise<void>;
}
