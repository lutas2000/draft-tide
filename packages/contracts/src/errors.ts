import { z } from 'zod';

// Stable error codes (M1 plan §11.1), defined once. GUI copy, CLI messages and
// MCP results all key off these codes; never match on message text.
//
// retryable: the same request may succeed later without anything else
// changing (another process finished, the network came back).
// noop: the request was valid and nothing needed doing. It is still reported
// as ok: false with this code, but it is not a failure (see exit codes below).
export const ERROR_CATALOG = {
  // M1 plan §11.1
  PROJECT_NOT_BOUND: { retryable: false },
  LOCAL_ROOT_UNAVAILABLE: { retryable: false },
  SCOPE_CHANGED: { retryable: false },
  PATH_OUTSIDE_ROOT: { retryable: false },
  UNSUPPORTED_ENTRY: { retryable: false },
  INSUFFICIENT_DISK_SPACE: { retryable: false },
  STORAGE_IO_FAILED: { retryable: false },
  RESOURCE_BUDGET_EXCEEDED: { retryable: false },
  SOURCE_BUSY: { retryable: true },
  LOCKED: { retryable: true },
  NO_CHANGES: { retryable: false, noop: true },
  CONFIRMATION_REQUIRED: { retryable: false },
  APPROVAL_DENIED: { retryable: false },
  PLAN_STALE: { retryable: false },
  UNTRACKED_FILES: { retryable: false },
  RECOVERY_REQUIRED: { retryable: false },
  PREVIEW_UNSUPPORTED: { retryable: false },
  PREVIEW_FAILED: { retryable: false },
  GIT_FAILED: { retryable: false },
  // Added by M0
  HISTORY_CHANGED: { retryable: true },
  PROTOCOL_MISMATCH: { retryable: false },
  UNAUTHENTICATED: { retryable: false },
  UNKNOWN_OPERATION: { retryable: false },
  // Added by the single-repo spike
  CONFIG_INVALID: { retryable: false },
  REPO_UNSUPPORTED: { retryable: false },
  REPO_BUSY: { retryable: true },
  UNSAVED_CHANGES: { retryable: false },
  AUTH_REQUIRED: { retryable: false },
  REMOTE_DIVERGED: { retryable: false },
  REMOTE_REJECTED: { retryable: false },
  NETWORK_UNAVAILABLE: { retryable: true },
  // Added by agent access (M1 plan v2.3)
  AGENT_ACCESS_DISABLED: { retryable: false },
  // Added by M1-01
  ENGINE_UNAVAILABLE: { retryable: true },
  INVALID_ARGUMENT: { retryable: false },
  INTERNAL_ERROR: { retryable: false },
  // Added by M1-04
  PROJECT_ALREADY_BOUND: { retryable: false },
  SNAPSHOT_NOT_FOUND: { retryable: false },
  // Added by M1-05: stopped at a safe boundary because the caller cancelled;
  // nothing was changed by the part that didn't run.
  CANCELLED: { retryable: false },
} as const satisfies Record<string, { retryable: boolean; noop?: true }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export function isNoopCode(code: ErrorCode): boolean {
  const entry: { retryable: boolean; noop?: true } = ERROR_CATALOG[code];
  return entry.noop === true;
}

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export const ErrorDetails = z.record(z.string().max(128), JsonValue);
export type ErrorDetails = z.infer<typeof ErrorDetails>;

export const ErrorInfo = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().max(4000),
  details: ErrorDetails,
  retryable: z.boolean(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

// The one error type that crosses module and process boundaries. Anything
// else that escapes is reported as INTERNAL_ERROR.
export class DtError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}, retryable?: boolean) {
    super(message);
    this.name = 'DtError';
    this.code = code;
    this.details = details;
    this.retryable = retryable ?? ERROR_CATALOG[code].retryable;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }

  static fromInfo(info: ErrorInfo): DtError {
    return new DtError(info.code, info.message, info.details, info.retryable);
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof DtError) return err.toInfo();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL_ERROR', message, details: {}, retryable: false };
}
