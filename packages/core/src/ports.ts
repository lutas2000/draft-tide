import type {
  AgentAccess,
  DesktopIdentityMode,
  EngineEvent,
  EngineInstanceId,
  IsoTimestamp,
  ProjectConfig,
  ProjectSummary,
  RepoBlocker,
  RepoWarning,
} from '@draft-tide/contracts';

// What core needs from the outside. The Engine's composition root provides
// real implementations (local-store, Node runtime); tests may provide their
// own. The remote provider port arrives with its implementation (M1-07).

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
  listProjects(): ProjectSummary[];
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
}

// ---- Git: the project's own repo (implemented by @draft-tide/git-backend)
//
// Named, read-only operations for scope and capture. Writes (objects, index,
// refs) arrive with M1-03. Paths are project-relative with `/` separators,
// exactly as Git reports them.

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
