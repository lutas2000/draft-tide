import { DtError, type JsonValue } from '@draft-tide/contracts';

export function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

// The path no longer names what it did: gone, or a parent swapped for a file.
export function isGone(e: unknown): boolean {
  const code = errnoOf(e);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function isDenied(e: unknown): boolean {
  const code = errnoOf(e);
  return code === 'EACCES' || code === 'EPERM';
}

// An I/O failure as a recoverable, classified error. Running out of space is
// INSUFFICIENT_DISK_SPACE wherever it happens (TECH_STACK §6.5).
export function ioError(e: unknown, what: string, details: Record<string, JsonValue> = {}): DtError {
  if (e instanceof DtError) return e;
  const code = errnoOf(e);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new DtError('INSUFFICIENT_DISK_SPACE', 'the disk ran out of space; nothing was saved', details);
  }
  return new DtError('STORAGE_IO_FAILED', `${what} failed${code ? ` (${code})` : ''}`, {
    ...details,
    ...(code ? { errno: code } : {}),
  });
}
