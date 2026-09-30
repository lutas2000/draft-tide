// Error codes. The first block is M1 plan §11.1 plus the M0 additions; the
// second block is what this spike needed on top (candidates for contracts).
export const ERROR_CODES = [
  'PROJECT_NOT_BOUND',
  'LOCAL_ROOT_UNAVAILABLE',
  'SCOPE_CHANGED',
  'PATH_OUTSIDE_ROOT',
  'UNSUPPORTED_ENTRY',
  'INSUFFICIENT_DISK_SPACE',
  'STORAGE_IO_FAILED',
  'RESOURCE_BUDGET_EXCEEDED',
  'SOURCE_BUSY',
  'LOCKED',
  'NO_CHANGES',
  'CONFIRMATION_REQUIRED',
  'APPROVAL_DENIED',
  'PLAN_STALE',
  'UNTRACKED_FILES',
  'RECOVERY_REQUIRED',
  'PREVIEW_UNSUPPORTED',
  'PREVIEW_FAILED',
  'BACKUP_INVALID',
  'GIT_FAILED',
  'HISTORY_CHANGED',
  'PROTOCOL_MISMATCH',
  'UNAUTHENTICATED',
  'UNKNOWN_OPERATION',
  // single-repo spike additions:
  'CONFIG_INVALID', // .drafttide.json missing fields / unsafe values / unknown schema
  'REPO_UNSUPPORTED', // a repo form M1 refuses (shallow, submodule, LFS, detached HEAD...)
  'REPO_BUSY', // repo is mid-operation (merge, rebase, unmerged index): retry after it ends
  'UNSAVED_CHANGES', // fast-forward / pull refused because the working files hold unsaved work
  'AUTH_REQUIRED', // remote rejected or asked for credentials
  'REMOTE_DIVERGED', // remote and local both moved: no silent merge, no force-push
  'REMOTE_REJECTED', // remote refused the push for another reason (protected branch, hook)
  'NETWORK_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DtError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, retryable = false) {
    super(message);
    this.name = 'DtError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}
