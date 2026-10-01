import { z } from 'zod';
import { JsonValue } from './errors.ts';

// What a design project's scope is made of, and why a folder or an entry in it
// can't be saved (M1 plan §6.2). The reasons are stable: GUI copy, the CLI and
// MCP key off them, so they are defined once here.

// REPO_UNSUPPORTED: a repo form Draft Tide refuses before writing anything.
export const REPO_UNSUPPORTED_REASONS = [
  // Where the folder is
  'inside-another-repo',
  'overlaps-app-data',
  // What `.git` is
  'dot-git-symlink',
  'linked-worktree-or-submodule',
  'dot-git-special',
  'foreign-owner',
  'bare-repo',
  // Repository format
  'unknown-repo-format',
  'sha256-object-format',
  'reftable',
  'partial-clone',
  'shallow-clone',
  // State that makes the index disagree with the working files
  'sparse-checkout',
  'index-flags',
  'gitlink-in-index',
  'nested-repo',
  'detached-head',
  // Attributes that make Git rewrite content, so raw bytes would disagree
  // with `git status`
  'git-lfs',
  'attribute-filter',
  'line-ending-normalization',
] as const;
export const RepoUnsupportedReason = z.enum(REPO_UNSUPPORTED_REASONS);
export type RepoUnsupportedReason = z.infer<typeof RepoUnsupportedReason>;

// REPO_BUSY (retryable): another Git operation is part-way through.
export const REPO_BUSY_REASONS = [
  'merge-in-progress',
  'rebase-in-progress',
  'cherry-pick-in-progress',
  'revert-in-progress',
  'sequencer-in-progress',
  'bisect-in-progress',
  'unmerged-entries',
] as const;
export const RepoBusyReason = z.enum(REPO_BUSY_REASONS);
export type RepoBusyReason = z.infer<typeof RepoBusyReason>;

const BlockerDetails = z.record(z.string().max(128), JsonValue);

export const RepoBlocker = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('REPO_UNSUPPORTED'), reason: RepoUnsupportedReason, details: BlockerDetails }),
  z.strictObject({ code: z.literal('REPO_BUSY'), reason: RepoBusyReason, details: BlockerDetails }),
]);
export type RepoBlocker = z.infer<typeof RepoBlocker>;

// Shown, never acted on: Draft Tide runs no hooks and ignores these settings
// (command-line overrides for local work, an empty git dir for network work).
export const REPO_WARNING_REASONS = ['hooks-present', 'dangerous-config', 'alternates'] as const;
export const RepoWarningReason = z.enum(REPO_WARNING_REASONS);
export type RepoWarningReason = z.infer<typeof RepoWarningReason>;

export const RepoWarning = z.strictObject({ reason: RepoWarningReason, details: BlockerDetails });
export type RepoWarning = z.infer<typeof RepoWarning>;

// UNSUPPORTED_ENTRY: something in scope that can't be saved as it is. Never
// skipped silently; the user excludes it or fixes it.
export const UNSUPPORTED_ENTRY_KINDS = [
  'symlink',
  'special',
  'parent-not-directory',
  'invalid-name',
  'non-utf8-name',
  'path-collision',
  'unreadable',
] as const;
export const UnsupportedEntryKind = z.enum(UNSUPPORTED_ENTRY_KINDS);
export type UnsupportedEntryKind = z.infer<typeof UnsupportedEntryKind>;

export const UnsupportedEntry = z.strictObject({
  path: z.string().max(4096),
  kind: UnsupportedEntryKind,
});
export type UnsupportedEntry = z.infer<typeof UnsupportedEntry>;

// Default excludes. They only keep *new* (untracked) files out of scope: a
// tracked file is always in, so a default can never become a silent deletion.
// Git's own matcher applies them (`ls-files --exclude`), like the
// `.drafttide.json` excludes, and they use the same character set.
export const DEFAULT_EXCLUDE_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.cache',
  '.parcel-cache',
  '.next',
  '.turbo',
  '.vite',
  '.pnpm-store',
  '.claude',
  '.cursor',
  '.idea',
  '.vscode',
];
export const DEFAULT_EXCLUDE_FILE_PATTERNS: readonly string[] = [
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.env',
  '.env.*',
  '*.log',
  '*.tmp',
  '*.swp',
  '*.swo',
  '~$*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.*.dt-tmp-*',
];

// Progress of one capture (M1 plan §6.3). There is no ETA: remaining time
// can't be estimated reliably.
export const CAPTURE_STAGES = ['scan', 'hash', 'stage', 'verify'] as const;
export const CaptureStage = z.enum(CAPTURE_STAGES);
export type CaptureStage = z.infer<typeof CaptureStage>;

export const CaptureProgress = z.strictObject({
  stage: CaptureStage,
  attempt: z.number().int().min(1),
  filesDone: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
});
export type CaptureProgress = z.infer<typeof CaptureProgress>;
