// Stable error codes proposed in M1 plan §11.1, plus the few extra ones the M0
// spike found it needed (marked). The real list belongs in packages/contracts.
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
  // M0 additions (candidates for contracts):
  'HISTORY_CHANGED', // ref CAS lost: HEAD moved between read and update
  'PROTOCOL_MISMATCH', // client/engine protocol or storage schema incompatible
  'UNAUTHENTICATED', // engine handshake failed
  'UNKNOWN_OPERATION', // op not exposed on this channel
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

export interface Envelope<T> {
  schemaVersion: 1;
  ok: boolean;
  data: T | null;
  warnings: string[];
  error: { code: ErrorCode; message: string; details: Record<string, unknown>; retryable: boolean } | null;
}

export function okEnvelope<T>(data: T, warnings: string[] = []): Envelope<T> {
  return { schemaVersion: 1, ok: true, data, warnings, error: null };
}

export function errorEnvelope(err: unknown): Envelope<never> {
  if (err instanceof DtError) {
    return {
      schemaVersion: 1,
      ok: false,
      data: null,
      warnings: [],
      error: { code: err.code, message: err.message, details: err.details, retryable: err.retryable },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    schemaVersion: 1,
    ok: false,
    data: null,
    warnings: [],
    error: { code: 'STORAGE_IO_FAILED', message, details: {}, retryable: false },
  };
}
