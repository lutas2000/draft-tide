import { lstat, mkdir, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DtError } from '@draft-tide/contracts';

// Where a project opened from GitHub goes (M1 plan §10.7): a folder that
// doesn't exist yet (its parent must) or an empty one. Nothing that is there
// is ever overwritten. Finder's `.DS_Store` doesn't count: a folder just made
// in the native picker may already have one.

const IGNORED = new Set(['.DS_Store']);

function contains(parent: string, child: string): boolean {
  const caseless = process.platform === 'darwin' || process.platform === 'win32';
  const a = caseless ? parent.toLowerCase() : parent;
  const b = caseless ? child.toLowerCase() : child;
  const rel = relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Folders a project is never opened into, whoever asks (an agent with agent
// access may open from GitHub): hidden folders anywhere on the path (~/.ssh,
// ~/.config/autostart…) and, on macOS, ~/Library (LaunchAgents…). Files
// written there could configure or run programs.
function refusedDestination(path: string): boolean {
  if (path.split(sep).some((segment) => segment.startsWith('.'))) return true;
  return process.platform === 'darwin' && contains(join(homedir(), 'Library'), path);
}

export interface DestinationState {
  // Canonical: the parent's real path and the folder's name.
  path: string;
  exists: boolean;
  empty: boolean;
}

function errno(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? 'unknown';
}

export async function inspectDestination(
  input: string,
  options: { appDataDir?: string } = {},
): Promise<DestinationState> {
  if (!isAbsolute(input)) {
    throw new DtError('INVALID_ARGUMENT', 'the folder must be given as an absolute path', { reason: 'relative-path' });
  }
  const name = basename(input);
  if (name === '' || name === '.' || name === '..') {
    throw new DtError('INVALID_ARGUMENT', 'the folder must be given by name', { reason: 'invalid-name' });
  }
  let parent: string;
  try {
    parent = await realpath(dirname(input));
  } catch (e) {
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the folder's parent folder is not available", {
      reason: errno(e).toLowerCase(),
    });
  }
  const path = join(parent, name);
  if (refusedDestination(path)) {
    throw new DtError('INVALID_ARGUMENT', 'projects are never opened into hidden or system folders; choose another', {
      reason: 'destination-not-allowed',
    });
  }
  if (options.appDataDir !== undefined) {
    let data: string;
    try {
      data = await realpath(options.appDataDir);
    } catch {
      data = resolve(options.appDataDir);
    }
    if (contains(path, data) || contains(data, path)) {
      throw new DtError('REPO_UNSUPPORTED', "this folder overlaps Draft Tide's own data folder", {
        reason: 'overlaps-app-data',
      });
    }
  }
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (errno(e) === 'ENOENT') return { path, exists: false, empty: true };
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the folder is not available', { reason: errno(e).toLowerCase() });
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new DtError('UNTRACKED_FILES', 'something other than a folder is at this place; choose an empty folder', {
      reason: 'destination-not-empty',
    });
  }
  const entries = (await readdir(path)).filter((n) => !IGNORED.has(n));
  return { path, exists: true, empty: entries.length === 0 };
}

export async function prepareDestination(
  input: string,
  options: { appDataDir?: string } = {},
): Promise<{ root: string; created: boolean }> {
  const dest = await inspectDestination(input, options);
  if (dest.exists) {
    if (!dest.empty) {
      throw new DtError('UNTRACKED_FILES', 'the folder is not empty; choose an empty folder', {
        reason: 'destination-not-empty',
      });
    }
    return { root: dest.path, created: false };
  }
  try {
    await mkdir(dest.path, { mode: 0o755 });
    return { root: dest.path, created: true };
  } catch (e) {
    // Made meanwhile: fine while it is still empty.
    if (errno(e) !== 'EEXIST') throw e;
    return prepareDestination(input, options);
  }
}

// Undoes an open that failed before its first file: the `.git` it created
// goes only while the folder holds nothing else, and the folder too when the
// open created it and it is empty then.
export async function removeFreshRepo(root: string, removeFolder: boolean): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  if (!names.every((n) => n === '.git' || IGNORED.has(n))) return;
  await rm(join(root, '.git'), { recursive: true, force: true });
  if (removeFolder) await rmdir(root).catch(() => undefined);
}
