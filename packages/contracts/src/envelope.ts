import { z } from 'zod';
import { ErrorInfo, isNoopCode, toErrorInfo } from './errors.ts';

// The machine result shape for CLI --json and MCP tool results (M1 plan
// §11.1). Exactly one envelope per CLI invocation on stdout.
export const ENVELOPE_SCHEMA_VERSION = 1;

export const Warning = z.strictObject({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .max(64),
  message: z.string().max(4000),
});
export type Warning = z.infer<typeof Warning>;

export interface Envelope<T> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  ok: boolean;
  data: T | null;
  warnings: Warning[];
  error: ErrorInfo | null;
}

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z
    .strictObject({
      schemaVersion: z.literal(ENVELOPE_SCHEMA_VERSION),
      ok: z.boolean(),
      data: data.nullable(),
      warnings: z.array(Warning),
      error: ErrorInfo.nullable(),
    })
    .refine((e) => e.ok === (e.error === null), { message: 'ok must be true exactly when error is null' });
}

export function okEnvelope<T>(data: T, warnings: Warning[] = []): Envelope<T> {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, ok: true, data, warnings, error: null };
}

export function errorEnvelope(err: unknown, warnings: Warning[] = []): Envelope<never> {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, ok: false, data: null, warnings, error: toErrorInfo(err) };
}

// CLI exit codes, derived from the envelope so every command agrees.
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  usage: 2,
  // A valid request that had nothing to do, such as saving with no changes.
  noop: 3,
} as const;

export function exitCodeFor(envelope: Pick<Envelope<unknown>, 'ok' | 'error'>): number {
  if (envelope.ok) return EXIT_CODES.ok;
  if (envelope.error && isNoopCode(envelope.error.code)) return EXIT_CODES.noop;
  if (envelope.error?.code === 'INVALID_ARGUMENT') return EXIT_CODES.usage;
  return EXIT_CODES.failed;
}

// MCP tool results set isError for real failures only, so a host does not
// report "nothing to save" as a broken tool.
export function isMcpError(envelope: Pick<Envelope<unknown>, 'ok' | 'error'>): boolean {
  return !envelope.ok && !(envelope.error && isNoopCode(envelope.error.code));
}
