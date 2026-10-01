import type {
  AgentAccess,
  CommitIdentity,
  DesktopIdentityMode,
  EngineEvent,
  EngineInstanceId,
  IsoTimestamp,
  OperationId,
  ProjectConfig,
  ProjectId,
  ProjectSummary,
  RepoBlocker,
  RepoWarning,
} from '@draft-tide/contracts';

// What core needs from the outside. The Engine's composition root provides
// real implementations (local-store, git-backend, adapter-filesystem, the Node
// runtime); tests may provide their own. The remote provider port arrives with
// its implementation (M1-07).

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
  // `git init` for a plain folder: empty template (no hooks), branch `main`.
  init(signal?: AbortSignal): Promise<void>;

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

// The design repo, as git-backend opens it.
export type ProjectGit = GitRepo & GitHistory;

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
  // The one working file Draft Tide writes before M1-05's write-back.
  writeProjectConfig(bytes: Uint8Array, expected: GitOid | null): Promise<void>;
}

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
