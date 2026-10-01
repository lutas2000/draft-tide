import { z } from 'zod';
import { ProjectSummary } from './engine.ts';
import { ErrorDetails } from './errors.ts';
import { GitObjectId, HistoryEntry, ChangeKind } from './history.ts';
import { IsoTimestamp, ProjectId } from './ids.ts';
import { CONFIG_INVALID_REASONS, RelativePath } from './project-config.ts';
import { RepoBlocker, RepoWarning, UnsupportedEntry } from './scope.ts';
import { isSingleLine } from './text.ts';

// Connecting a design folder and reading its state (M1 plan §2.1, §6.2). The
// folder's absolute path appears only here, for local clients: never in
// history, commit metadata or `.drafttide.json`.

const DisplayPath = z.string().max(4096);
const Count = z.number().int().nonnegative();

// A folder as the user picked it. The Engine resolves it to its canonical
// (real) path; the path itself is never authorization.
export const FolderPath = z.string().min(1).max(4096).refine(isSingleLine, 'must be a single line');

export const ProjectName = z.string().max(200).refine(isSingleLine, 'must be a single line');

// Up to 50 sample paths of a longer list.
export const Excerpt = z.strictObject({ count: Count, sample: z.array(DisplayPath).max(50) });
export type Excerpt = z.infer<typeof Excerpt>;

export const ENTRY_FILE_STATUSES = ['included', 'excluded', 'missing', 'unsupported'] as const;
export const EntryFileStatus = z.enum(ENTRY_FILE_STATUSES);
export type EntryFileStatus = z.infer<typeof EntryFileStatus>;

export const RepoState = z.strictObject({
  // false: a plain folder; connecting it runs `git init` (branch main).
  hasRepo: z.boolean(),
  branch: z.string().max(1024).nullable(),
  // null while the branch has no commit yet.
  tip: GitObjectId.nullable(),
  warnings: z.array(RepoWarning).max(16),
});
export type RepoState = z.infer<typeof RepoState>;

// The folder's own `.drafttide.json`, if it has one (untrusted input).
export const ExistingConfig = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({
    status: z.literal('valid'),
    projectId: ProjectId,
    name: ProjectName,
    entryFiles: z.array(RelativePath).max(16),
  }),
  z.strictObject({ status: z.literal('invalid'), reason: z.enum(CONFIG_INVALID_REASONS), details: ErrorDetails }),
]);
export type ExistingConfig = z.infer<typeof ExistingConfig>;

//   new              not connected on this computer
//   bound-here       this folder is already connected (open it instead)
//   bound-elsewhere  its settings name a project connected to another folder:
//                    a copy (available) or a folder that moved (not available)
export const BindingState = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('new') }),
  z.strictObject({ status: z.literal('bound-here'), project: ProjectSummary }),
  z.strictObject({ status: z.literal('bound-elsewhere'), project: ProjectSummary, available: z.boolean() }),
]);
export type BindingState = z.infer<typeof BindingState>;

// What the GUI shows before a folder is connected (M1 plan §4.1 範圍審查).
// Nothing in the folder or its `.git` is written to produce it.
export const FolderReview = z.strictObject({
  root: DisplayPath,
  folderName: z.string().max(255),
  repo: RepoState,
  // Every reason the folder can't be saved as it is: repo form, repo state,
  // attributes. Empty when it can be connected.
  blockers: z.array(RepoBlocker).max(64),
  // false when the repo's form is unsupported: the scope was not listed, and
  // the counts below are empty rather than zero.
  scopeListed: z.boolean(),
  included: z.strictObject({
    files: Count,
    bytes: Count,
    largest: z.array(z.strictObject({ path: DisplayPath, size: Count })).max(10),
  }),
  // Tracked by Git but gone from the folder: the first version won't have them.
  deleted: Excerpt,
  unsupported: z.strictObject({ count: Count, entries: z.array(UnsupportedEntry).max(100) }),
  excluded: Excerpt,
  excludedByDefaults: Excerpt,
  entryFiles: z.array(z.strictObject({ path: DisplayPath, status: EntryFileStatus })).max(16),
  entryCandidates: z.array(DisplayPath).max(20),
  config: ExistingConfig,
  binding: BindingState,
  suggestedName: ProjectName,
  // Free space where the history goes (the folder's volume).
  freeBytes: Count.nullable(),
  // Names exactly what was reviewed. Connecting checks it again and refuses
  // with SCOPE_CHANGED when files came or went, or the repo moved, meanwhile.
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});
export type FolderReview = z.infer<typeof FolderReview>;

export const ProjectReviewInput = z.strictObject({ root: FolderPath });

export const ProjectBindInput = z.strictObject({
  root: FolderPath,
  name: ProjectName,
  // Pages used for previews; each must be an included file.
  entryFiles: z.array(RelativePath).max(16),
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
  // The user chose to connect a copied folder as a project of its own: a new
  // projectId is written into its `.drafttide.json`.
  asNewProject: z.boolean().optional(),
});

export const ProjectBindResult = z.strictObject({
  project: ProjectSummary,
  // `git init` ran (the folder had no repo).
  initialized: z.boolean(),
  // `.drafttide.json` was written (new, renamed or a new projectId).
  configWritten: z.boolean(),
  // The project was connected to another folder that is gone; it now uses
  // this one.
  relinked: z.boolean(),
});
export type ProjectBindResult = z.infer<typeof ProjectBindResult>;

// ---- Status of a connected project (M1 plan §3 查看狀態)

//   available         the folder, its history and its settings are in place
//   missing           the folder is gone, moved, or now a link elsewhere
//   repo-missing      the folder has no `.git` any more: its history is gone
//   config-missing    `.drafttide.json` was deleted
//   config-invalid    `.drafttide.json` can't be used (see configProblem)
//   project-mismatch  `.drafttide.json` names another project
export const FOLDER_STATES = [
  'available',
  'missing',
  'repo-missing',
  'config-missing',
  'config-invalid',
  'project-mismatch',
] as const;
export const FolderState = z.enum(FOLDER_STATES);
export type FolderState = z.infer<typeof FolderState>;

export const StatusChange = z.strictObject({
  path: DisplayPath,
  change: ChangeKind,
  previousPath: DisplayPath.nullable(),
});
export type StatusChange = z.infer<typeof StatusChange>;

export const STATUS_CHANGES_MAX = 500;

export const ProjectStatus = z.strictObject({
  project: ProjectSummary,
  folder: FolderState,
  configProblem: z.strictObject({ reason: z.enum(CONFIG_INVALID_REASONS), details: ErrorDetails }).nullable(),
  // From `.drafttide.json` when it can be read, else as last connected.
  name: ProjectName,
  entryFiles: z.array(RelativePath).max(16),
  branch: z.string().max(1024).nullable(),
  // The newest commit on the branch: a version, or another tool's commit.
  tip: HistoryEntry.nullable(),
  blockers: z.array(RepoBlocker).max(64),
  warnings: z.array(RepoWarning).max(16),
  // A save that didn't finish left Draft Tide's lock in `.git`; saving is
  // refused until recovery completes it (M1-05).
  recoveryRequired: z.boolean(),
  // A save of this project is running or queued.
  saving: z.boolean(),
  // The folder compared with the newest commit: what the next save would
  // record. null when it can't be computed (folder, repo or settings
  // unavailable, or the repo can't be used).
  changes: z
    .strictObject({
      total: Count,
      added: Count,
      modified: Count,
      deleted: Count,
      renamed: Count,
      entries: z.array(StatusChange).max(STATUS_CHANGES_MAX),
    })
    .nullable(),
  unsupported: z.strictObject({ count: Count, entries: z.array(UnsupportedEntry).max(100) }),
  checkedAt: IsoTimestamp,
});
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProjectStatusInput = z.strictObject({ projectId: ProjectId });
