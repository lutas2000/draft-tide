/**
 * Prototype-only types. Field names mirror the M1 contracts proposal (§5.2
 * SnapshotMetadata, §9.2 RestorePlan, §9.3 operation states) so the flow can be
 * judged against the planned data model. Nothing here is a real contract.
 */

import type { DesignOpts } from './designs';

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SnapshotId = Brand<string, 'SnapshotId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type OperationId = Brand<string, 'OperationId'>;

export type SnapshotKind = 'baseline' | 'manual' | 'agent-requested' | 'pre-restore' | 'restore';
export type EntryOrigin = 'gui' | 'cli' | 'mcp';

/** M1 §5.2. No absolute paths, prompts, keys or approval secrets. */
export interface SnapshotMetadata {
  schemaVersion: 1;
  snapshotId: SnapshotId;
  kind: SnapshotKind;
  /** UTC ISO 8601 */
  createdAt: string;
  scopeHash: string;
  provider: 'filesystem';
  entryFiles: readonly string[];
  name?: string;
  origin?: EntryOrigin;
  restoreOf?: SnapshotId;
  operationId?: OperationId;
}

export interface FileEntry {
  /** Path relative to the project root, POSIX separators. */
  path: string;
  size: number;
  /** Content hash (pseudo SHA-256 in the prototype). */
  hash: string;
  kind: 'text' | 'binary';
  /** Present for text files. */
  text?: string;
  /**
   * Prototype-only: inline SVG markup the fake preview renderer substitutes
   * for this binary asset (we ship no real PNG bytes).
   */
  previewArt?: string;
}

export type FileSet = readonly FileEntry[];

export type PreviewStatus = 'pending' | 'ready' | 'failed';

export interface Version {
  meta: SnapshotMetadata;
  /** Git commit OID in the project's isolated history (pseudo). Details only. */
  commitOid: string;
  /** Display label only (V1…Vn), never a permanent reference. */
  label: string;
  files: FileSet;
  previewStatus: PreviewStatus;
  /** Prototype-only: the example design this snapshot was generated from. */
  design: DesignOpts;
}

export type DesignFamily = 'aurora' | 'nimbus';

export interface Project {
  id: ProjectId;
  name: string;
  folderName: string;
  /** Display only; never written into snapshot metadata or backups. */
  displayPath: string;
  entry: string;
  scopeHash: string;
  family: DesignFamily;
  sourceAvailable: boolean;
  versions: Version[];
  /** Simulated live folder content (what the designer's editor sees). */
  working: FileSet;
  /** Prototype-only: design options behind `working`, used to script the next edit. */
  workingDesign: DesignOpts;
  createdAt: string;
  lastOpenedAt: string;
  importedFrom?: string;
}

export type ChangeStatus = 'modified' | 'added' | 'deleted';

export interface FileChange {
  path: string;
  status: ChangeStatus;
  before?: FileEntry;
  after?: FileEntry;
}

export interface ExcludedEntry {
  path: string;
  kind: 'dir' | 'file';
  reason: string;
  detail: string;
}

export interface UnsupportedEntry {
  path: string;
  kind: 'symlink';
  target: string;
  detail: string;
}

export interface ScopeDraft {
  source: 'example' | 'folder';
  folderName: string;
  displayPath: string;
  suggestedName: string;
  entryCandidates: readonly string[];
  files: FileSet;
  excluded: readonly ExcludedEntry[];
  unsupported: readonly UnsupportedEntry[];
  historyLocation: string;
  freeSpace: number;
}

/** M1 §9.2 (subset). planId identifies the plan; it is not an approval. */
export interface RestorePlan {
  planId: PlanId;
  projectId: ProjectId;
  targetId: SnapshotId;
  baseHead: SnapshotId;
  scopeHash: string;
  /** Fingerprint of the working files when the plan was made. */
  fingerprint: string;
  /** Per-file hashes seen when planning (lets PLAN_STALE name what changed). */
  observed: ReadonlyArray<{ path: string; hash: string }>;
  overwrite: FileChange[];
  add: FileChange[];
  remove: FileChange[];
  /** New files not in any version that the plan would overwrite / delete. */
  untracked: FileEntry[];
  /** Unsaved changes that will be kept in a pre-restore protection version. */
  unsaved: FileChange[];
  createdAt: string;
  expiresAt: string;
}

/** M1 §9.3 */
export type OperationStatus =
  | 'planned'
  | 'confirmed'
  | 'preflight'
  | 'protected'
  | 'staged'
  | 'applying'
  | 'verified'
  | 'committed'
  | 'completed'
  | 'recovery-required';

export interface PendingApproval {
  id: string;
  projectId: ProjectId;
  kind: 'restore';
  origin: EntryOrigin;
  targetId: SnapshotId;
  requestedAt: string;
  callerLabel: string;
}

export interface FolderChoice {
  displayPath: string;
  folderName: string;
  note: string;
  boundProjectId?: ProjectId;
  empty?: boolean;
}
