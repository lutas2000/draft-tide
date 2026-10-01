import { z } from 'zod';
import { IsoTimestamp, ProjectId, SnapshotId, UUID_PATTERN } from './ids.ts';
import { Origin, SnapshotKind, SnapshotName } from './snapshot.ts';

// Versions, history and comparison as they cross the process boundary (M1 plan
// §5.2, §7.2). History is read from the project's own Git repo; these are
// views of it, never a second record of which versions exist.

// A full Git object id. SHA-256 repositories are refused, so always 40 hex.
export const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
export const GitObjectId = z.string().regex(GIT_OID_PATTERN, 'must be a 40-character Git object id');
export type GitObjectId = z.infer<typeof GitObjectId>;

// A permanent reference to a version: its snapshot id, or the id of a commit
// in the project's history (other tools' commits have no snapshot id). Never a
// revision expression (HEAD~1, branch names, short ids).
export const VersionRef = z
  .string()
  .refine((v) => UUID_PATTERN.test(v) || GIT_OID_PATTERN.test(v), 'must be a snapshot id or a 40-character commit id');
export type VersionRef = z.infer<typeof VersionRef>;

// Text that came from Git (commit titles, other tools' author names): control
// characters are replaced before it leaves the Engine, so no client can be
// handed a terminal escape sequence.
const DisplayText = (max: number) => z.string().max(max);
const DisplayPath = z.string().max(4096);
const Count = z.number().int().nonnegative();

// Where a commit on the branch came from.
//   draft-tide  a version Draft Tide saved
//   external    made by another tool (an engineer, an agent's own `git commit`)
//   unreadable  carries Draft Tide metadata that can't be trusted, or a newer
//               Draft Tide's
//   copy        a Draft Tide commit copied by another tool (cherry-pick, amend
//               of a copy): it repeats the snapshot id of an older version
export const HISTORY_SOURCES = ['draft-tide', 'external', 'unreadable', 'copy'] as const;
export const HistorySource = z.enum(HISTORY_SOURCES);
export type HistorySource = z.infer<typeof HistorySource>;

export const SnapshotInfo = z.strictObject({
  snapshotId: SnapshotId,
  kind: SnapshotKind,
  name: SnapshotName.nullable(),
  createdAt: IsoTimestamp,
  origin: Origin,
  restoreOf: SnapshotId.nullable(),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfo>;

export const HistoryEntry = z.strictObject({
  commit: GitObjectId,
  parents: z.array(GitObjectId).max(64),
  // First line of the message.
  title: DisplayText(200),
  source: HistorySource,
  // Only for source draft-tide.
  snapshot: SnapshotInfo.nullable(),
  unreadable: z.enum(['invalid', 'newer-schema']).nullable(),
  // For source copy: the commit that first carried the snapshot id.
  copyOf: GitObjectId.nullable(),
  // Display number of a Draft Tide version (V1, V2…), counted along the
  // branch's first-parent line from its oldest version. Not a permanent id.
  seq: z.number().int().positive().nullable(),
  authorName: DisplayText(200),
  committedAt: IsoTimestamp.nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const HistoryPage = z.strictObject({
  branch: z.string().max(1024),
  tip: GitObjectId.nullable(),
  // Commits on the first-parent line, and the Draft Tide versions among them.
  total: Count,
  versions: Count,
  entries: z.array(HistoryEntry).max(200),
  // Where the next page starts; null on the last page.
  nextSkip: Count.nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

export const HISTORY_PAGE_MAX = 200;

export const HistoryListInput = z.strictObject({
  projectId: ProjectId,
  skip: Count.max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
});

// ---- Saving

export const SnapshotCreateInput = z.strictObject({
  projectId: ProjectId,
  name: SnapshotName.optional(),
});

export const SavedSnapshot = z.strictObject({
  projectId: ProjectId,
  snapshotId: SnapshotId,
  kind: SnapshotKind,
  name: SnapshotName.nullable(),
  createdAt: IsoTimestamp,
  origin: Origin,
  commit: GitObjectId,
  tree: GitObjectId,
  // The version it was built on; null for the first commit of the branch.
  parent: GitObjectId.nullable(),
  branch: z.string().max(1024),
  files: Count,
  bytes: Count,
  // Content Git didn't have before this save, deduplicated.
  newObjects: Count,
  newBytes: Count,
});
export type SavedSnapshot = z.infer<typeof SavedSnapshot>;

// ---- Comparing two versions (M1 plan §7.2)

export const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const;
export const ChangeKind = z.enum(CHANGE_KINDS);
export type ChangeKind = z.infer<typeof ChangeKind>;

// One file of a version's tree. Mode as Git records it: 100644, 100755,
// 120000 (a symlink another tool committed), 160000 (a gitlink).
export const TreeFile = z.strictObject({
  mode: z.string().regex(/^[0-7]{6}$/),
  oid: GitObjectId,
  size: Count.nullable(),
});
export type TreeFile = z.infer<typeof TreeFile>;

// renamed: the same content moved (identical bytes and mode), so it needs no
// new object. A rename with edits shows as deleted plus added.
export const FileChange = z.strictObject({
  path: DisplayPath,
  change: ChangeKind,
  previousPath: DisplayPath.nullable(),
  before: TreeFile.nullable(),
  after: TreeFile.nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

export const ChangeSummary = z.strictObject({
  total: Count,
  added: Count,
  modified: Count,
  deleted: Count,
  renamed: Count,
});
export type ChangeSummary = z.infer<typeof ChangeSummary>;

export const VersionInfo = z.strictObject({
  commit: GitObjectId,
  snapshotId: SnapshotId.nullable(),
  seq: z.number().int().positive().nullable(),
  title: DisplayText(200),
});
export type VersionInfo = z.infer<typeof VersionInfo>;

export const SnapshotDiffInput = z.strictObject({
  projectId: ProjectId,
  from: VersionRef,
  to: VersionRef,
});

export const SnapshotDiff = z.strictObject({
  from: VersionInfo,
  to: VersionInfo,
  summary: ChangeSummary,
  // In path order; cut short (truncated) when the list would not fit in one
  // control message. The summary always counts everything.
  changes: z.array(FileChange).max(5000),
  truncated: z.boolean(),
});
export type SnapshotDiff = z.infer<typeof SnapshotDiff>;

export const SnapshotDiffFileInput = z.strictObject({
  projectId: ProjectId,
  from: VersionRef,
  to: VersionRef,
  path: DisplayPath.min(1),
});

export const LINE_ENDINGS = ['lf', 'crlf', 'mixed', 'none'] as const;
export const LineEndings = z.enum(LINE_ENDINGS);
export type LineEndings = z.infer<typeof LineEndings>;

// A unified-diff hunk. Each line starts with ' ' (context), '+' (added) or
// '-' (removed), followed by the line without its line break. A trailing CR is
// kept, so CRLF files show as they are.
export const DiffHunk = z.strictObject({
  oldStart: Count,
  oldLines: Count,
  newStart: Count,
  newLines: Count,
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

// Why a file is shown as a summary (sizes and content ids) instead of lines.
//   binary       not text Draft Tide can decode safely (NUL bytes, not UTF-8)
//   too-large    larger than the text-diff budget
//   too-complex  the line diff gave up within its time and edit budgets
//   not-a-file   a symlink or gitlink another tool committed
//   identical    the same content on both sides
export const DIFF_SUMMARY_REASONS = ['binary', 'too-large', 'too-complex', 'not-a-file', 'identical'] as const;
export const DiffSummaryReason = z.enum(DIFF_SUMMARY_REASONS);
export type DiffSummaryReason = z.infer<typeof DiffSummaryReason>;

export const FileDiff = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    path: DisplayPath,
    before: TreeFile.nullable(),
    after: TreeFile.nullable(),
    added: Count,
    removed: Count,
    hunks: z.array(DiffHunk),
    // The hunks were cut short to fit one control message.
    truncated: z.boolean(),
    lineEndings: z.strictObject({ before: LineEndings.nullable(), after: LineEndings.nullable() }),
    missingFinalNewline: z.strictObject({ before: z.boolean(), after: z.boolean() }),
  }),
  z.strictObject({
    kind: z.literal('summary'),
    path: DisplayPath,
    before: TreeFile.nullable(),
    after: TreeFile.nullable(),
    reason: DiffSummaryReason,
  }),
]);
export type FileDiff = z.infer<typeof FileDiff>;
