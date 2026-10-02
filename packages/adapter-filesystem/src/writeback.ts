import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DtError } from '@draft-tide/contracts';
import type { GitBlobMode, GitOid, Occupant, WriteOutcome } from '@draft-tide/core';
import { digestFile } from './digest.ts';
import { errnoOf, ioError, isGone } from './io.ts';

// Writing restored files back into the design folder (M1 plan §9.3 step 6).
// One file at a time, and only while the path still holds what the operation
// expects: a file with a known content id, or nothing. Each write goes
// through an exclusive temporary file in the same folder (never across
// volumes), flushed before it replaces the file by rename. Parents must be
// real folders; missing ones are created, a link or file in their place
// refuses. Node has no openat, so a parent swapped for a link between the
// check and the rename can't be excluded; the check runs as late as it can.

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHANGED: WriteOutcome = { changed: true };
const DONE: WriteOutcome = { changed: false };
// Matches the default exclude `.*.dt-tmp-*`, so a leftover is never saved.
const TEMP_PREFIX = '.restore.dt-tmp-';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Parents = 'ok' | 'missing' | 'not-folder';

// Every parent of rel is a real folder (ok), one is missing (and so is the
// path), or one is something else.
async function checkParents(root: string, rel: string): Promise<Parents> {
  const parts = rel.split('/');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st: BigIntStats;
    try {
      st = await lstat(cur, { bigint: true });
    } catch (e) {
      if (isGone(e)) return 'missing';
      throw ioError(e, 'reading the design folder', { volume: 'project' });
    }
    if (!st.isDirectory()) return 'not-folder';
  }
  return 'ok';
}

// Creates missing parents as real folders (0755, whatever the Engine's
// umask). false when something else is in the way.
async function ensureParents(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (!st.isDirectory()) return false;
      continue;
    } catch (e) {
      if (!isGone(e)) throw ioError(e, 'reading the design folder', { volume: 'project' });
    }
    try {
      await mkdir(cur, { mode: 0o755 });
      await chmod(cur, 0o755);
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') throw ioError(e, 'creating a folder', { volume: 'project' });
      if (!(await lstat(cur)).isDirectory()) return false;
    }
  }
  return true;
}

// Whether the path holds exactly `expected`: a regular file with that content
// id, or (null) nothing at all. An empty folder where a file is expected to
// be absent is removed: it is what deleting its files left behind.
async function holds(root: string, rel: string, expected: GitOid | null, signal?: AbortSignal): Promise<boolean> {
  const parents = await checkParents(root, rel);
  if (parents === 'not-folder') return false;
  if (parents === 'missing') return expected === null;
  const abs = join(root, rel);
  let st: BigIntStats;
  try {
    st = await lstat(abs, { bigint: true });
  } catch (e) {
    if (isGone(e)) return expected === null;
    throw ioError(e, 'reading the design folder', { volume: 'project' });
  }
  if (expected === null) {
    if (!st.isDirectory()) return false;
    try {
      await rmdir(abs);
      return true;
    } catch (e) {
      const code = errnoOf(e);
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
      throw ioError(e, 'removing an empty folder', { volume: 'project' });
    }
  }
  // The file must be this name, not another spelling of it the filesystem
  // resolves to the same entry.
  if (!st.isFile() || !(await isExact(root, rel))) return false;
  const identity = { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
  const r = await digestFile(root, rel, identity, null, signal);
  return !r.changed && r.digest.oid === expected;
}

// Whether rel exists spelled exactly so: every segment is an entry of its
// parent as listed, not only a name the filesystem treats as the same.
async function isExact(
  root: string,
  rel: string,
  listings = new Map<string, Promise<Set<string>>>(),
): Promise<boolean> {
  const parts = rel.split('/');
  let dir = root;
  for (const part of parts) {
    let names = listings.get(dir);
    if (!names) {
      names = readdir(dir).then(
        (n) => new Set(n),
        (e: unknown) => {
          if (isGone(e)) return new Set<string>();
          throw ioError(e, 'reading the design folder', { volume: 'project' });
        },
      );
      listings.set(dir, names);
    }
    if (!(await names).has(part)) return false;
    dir = join(dir, part);
  }
  return true;
}

export async function exactNamesOf(root: string, paths: readonly string[]): Promise<boolean[]> {
  const listings = new Map<string, Promise<Set<string>>>();
  return Promise.all(paths.map((p) => isExact(root, p, listings)));
}

// The rename itself is made durable where folders can be flushed.
async function syncFolder(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(dir, constants.O_RDONLY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Windows refuses to replace a file another process has open (an editor
// in the middle of saving it): such a rename is retried briefly, each time
// after checking the expected content again.
const RENAME_ATTEMPTS = 40;

function isTransientRename(e: unknown): boolean {
  const code = errnoOf(e);
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
}

// content must have the blob id `oid`; checked on the written file before it
// replaces anything, so a cut-short stream never takes the place of a file.
export async function writeFileBack(
  root: string,
  rel: string,
  content: AsyncIterable<Uint8Array>,
  options: { mode: GitBlobMode; expected: GitOid | null; oid: GitOid },
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  if (!(await ensureParents(root, rel))) return CHANGED;
  const abs = join(root, rel);
  const dir = dirname(abs);
  const name = `${TEMP_PREFIX}${randomUUID()}`;
  const tmp = join(dir, name);
  const tmpRel = [...rel.split('/').slice(0, -1), name].join('/');
  try {
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await fh.chmod(options.mode === '100755' ? 0o755 : 0o644);
    } catch (e) {
      await fh.close();
      throw e;
    }
    // The write stream flushes the file to disk and closes it.
    await pipeline(Readable.from(content), fh.createWriteStream({ flush: true }), signal ? { signal } : {});
    const st = await lstat(tmp, { bigint: true });
    const identity = { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
    const written = await digestFile(root, tmpRel, identity, null, signal);
    if (written.changed || written.digest.oid !== options.oid) {
      throw new DtError('GIT_FAILED', 'Git delivered different content than the version holds; nothing was replaced');
    }
    for (let attempt = 1; ; attempt++) {
      // As late as possible: the path still holds what the operation expects.
      if (!(await holds(root, rel, options.expected, signal))) {
        await rm(tmp, { force: true });
        return CHANGED;
      }
      try {
        await rename(tmp, abs);
        break;
      } catch (e) {
        if (!isTransientRename(e) || attempt >= RENAME_ATTEMPTS) throw e;
        await sleep(25);
      }
    }
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw signal.reason;
    throw ioError(e, 'writing a design file', { volume: 'project' });
  }
  await syncFolder(dir).catch(() => undefined);
  return DONE;
}

export async function removeFileBack(
  root: string,
  rel: string,
  expected: GitOid,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  if (!(await holds(root, rel, expected, signal))) return CHANGED;
  const abs = join(root, rel);
  try {
    await unlink(abs);
  } catch (e) {
    if (!isGone(e)) throw ioError(e, 'deleting a design file', { volume: 'project' });
  }
  // Folders the deletion left empty go too, as Git's own checkout does.
  const parts = rel.split('/').slice(0, -1);
  while (parts.length > 0) {
    try {
      await rmdir(join(root, ...parts));
    } catch {
      break;
    }
    parts.pop();
  }
  await syncFolder(dirname(abs)).catch(() => undefined);
  return DONE;
}

export async function occupantsOf(root: string, paths: readonly string[]): Promise<Occupant[]> {
  return Promise.all(
    paths.map(async (rel): Promise<Occupant> => {
      try {
        const st = await lstat(join(root, rel));
        if (st.isSymbolicLink()) return 'link';
        if (st.isFile()) return 'file';
        if (st.isDirectory()) return 'folder';
        return 'other';
      } catch (e) {
        if (isGone(e)) return 'missing';
        throw ioError(e, 'reading the design folder', { volume: 'project' });
      }
    }),
  );
}

// Everything inside a folder that isn't itself a folder, project-relative,
// without following links.
export async function listFolderEntries(
  root: string,
  rel: string,
  max: number,
): Promise<{ entries: string[]; complete: boolean }> {
  const entries: string[] = [];
  const walk = async (dirRel: string): Promise<boolean> => {
    let names;
    try {
      names = await readdir(join(root, dirRel), { withFileTypes: true });
    } catch (e) {
      if (isGone(e)) return true;
      throw ioError(e, 'reading the design folder', { volume: 'project' });
    }
    for (const d of names) {
      const child = `${dirRel}/${d.name}`;
      if (d.isDirectory()) {
        if (!(await walk(child))) return false;
        continue;
      }
      if (entries.length >= max) return false;
      entries.push(child);
    }
    return true;
  };
  const complete = await walk(rel);
  return { entries, complete };
}
