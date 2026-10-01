import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DtError } from '@draft-tide/contracts';

// The canonical form of a folder the user picked (M1 plan §6.2): its real path
// with symlinks resolved, so one folder is one binding however it was reached.
// The path itself is never authorization; the GUI's scope review is.

function contains(parent: string, child: string): boolean {
  const caseless = process.platform === 'darwin' || process.platform === 'win32';
  const a = caseless ? parent.toLowerCase() : parent;
  const b = caseless ? child.toLowerCase() : child;
  const rel = relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

export interface CanonicalRootOptions {
  // Draft Tide's own data directory. A project may not contain it (its staging
  // would become part of the scope) or live inside it.
  appDataDir?: string;
}

export async function canonicalRoot(input: string, options: CanonicalRootOptions = {}): Promise<string> {
  if (!isAbsolute(input)) throw new DtError('INVALID_ARGUMENT', 'the design folder must be given as an absolute path');
  let real: string;
  try {
    real = await realpath(input);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the design folder is not available', { reason: code.toLowerCase() });
  }
  if (!(await stat(real)).isDirectory()) {
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the design folder is not a folder', { reason: 'not-a-directory' });
  }
  if (options.appDataDir !== undefined) {
    const data = await realOrResolved(options.appDataDir);
    if (contains(real, data) || contains(data, real)) {
      throw new DtError('REPO_UNSUPPORTED', "this folder overlaps Draft Tide's own data folder", {
        reason: 'overlaps-app-data',
      });
    }
  }
  return real;
}
