import { describe, expect, it } from 'vitest';
import {
  DtError,
  ERROR_CATALOG,
  EXIT_CODES,
  JsonValue,
  envelopeSchema,
  errorEnvelope,
  exitCodeFor,
  isMcpError,
  okEnvelope,
} from '../src/index.ts';

describe('error catalog', () => {
  it('holds every code the M1 plan §11.1 requires', () => {
    const required = [
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
      'GIT_FAILED',
      'HISTORY_CHANGED',
      'PROTOCOL_MISMATCH',
      'UNAUTHENTICATED',
      'UNKNOWN_OPERATION',
      'CONFIG_INVALID',
      'REPO_UNSUPPORTED',
      'REPO_BUSY',
      'UNSAVED_CHANGES',
      'AUTH_REQUIRED',
      'REMOTE_DIVERGED',
      'REMOTE_REJECTED',
      'NETWORK_UNAVAILABLE',
      'AGENT_ACCESS_DISABLED',
    ];
    for (const code of required) expect(ERROR_CATALOG).toHaveProperty(code);
    expect(ERROR_CATALOG).not.toHaveProperty('BACKUP_INVALID');
  });

  it('marks the retryable codes from the plan', () => {
    for (const code of ['LOCKED', 'REPO_BUSY', 'NETWORK_UNAVAILABLE', 'SOURCE_BUSY', 'HISTORY_CHANGED'] as const) {
      expect(new DtError(code, 'x').retryable).toBe(true);
    }
    expect(new DtError('PLAN_STALE', 'x').retryable).toBe(false);
  });
});

describe('envelope', () => {
  const schema = envelopeSchema(JsonValue);

  it('ok envelopes validate and exit 0', () => {
    const env = okEnvelope({ a: 1 });
    expect(schema.parse(env)).toEqual(env);
    expect(exitCodeFor(env)).toBe(EXIT_CODES.ok);
    expect(isMcpError(env)).toBe(false);
  });

  it('carries DtError fields unchanged', () => {
    const env = errorEnvelope(new DtError('PLAN_STALE', 'files changed', { files: 2 }));
    expect(schema.parse(env).error).toEqual({
      code: 'PLAN_STALE',
      message: 'files changed',
      details: { files: 2 },
      retryable: false,
    });
    expect(exitCodeFor(env)).toBe(EXIT_CODES.failed);
    expect(isMcpError(env)).toBe(true);
  });

  it('reports anything else as INTERNAL_ERROR', () => {
    expect(errorEnvelope(new TypeError('boom')).error?.code).toBe('INTERNAL_ERROR');
    expect(errorEnvelope('nope').error?.code).toBe('INTERNAL_ERROR');
  });

  it('treats NO_CHANGES as a no-op, not a failure', () => {
    const env = errorEnvelope(new DtError('NO_CHANGES', 'nothing to save'));
    expect(env.ok).toBe(false);
    expect(exitCodeFor(env)).toBe(EXIT_CODES.noop);
    expect(isMcpError(env)).toBe(false);
  });

  it('maps INVALID_ARGUMENT to the usage exit code', () => {
    expect(exitCodeFor(errorEnvelope(new DtError('INVALID_ARGUMENT', 'bad')))).toBe(EXIT_CODES.usage);
  });

  it('rejects an envelope whose ok flag disagrees with its error', () => {
    expect(schema.safeParse({ ...okEnvelope(1), ok: false }).success).toBe(false);
  });
});
