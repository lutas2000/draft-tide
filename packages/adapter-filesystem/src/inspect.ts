import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit, type PathInspection } from '@draft-tide/core';
import { ioError, isDenied, isGone } from './io.ts';

const CONCURRENCY = 16;

type ParentVerdict = 'ok' | 'missing' | 'parent-not-directory' | 'unreadable';

// lstat for paths Git hands over (M1 plan §6.2). Every parent directory must
// be a real directory: a tracked `a/secret.txt` whose `a` was replaced by a
// symlink to another folder is refused, never read (single-repo spike A7).
// Nothing is followed: a symlink at the end is reported as one.
export async function inspectPaths(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<PathInspection[]> {
  const parents = new Map<string, Promise<ParentVerdict>>();

  const checkDir = (prefix: string): Promise<ParentVerdict> => {
    let verdict = parents.get(prefix);
    if (!verdict) {
      // A folder replaced by a file is a deletion for Git, like a missing one;
      // a symlink or anything else in its place is refused.
      verdict = lstat(join(root, prefix)).then(
        (st) => (st.isDirectory() ? 'ok' : st.isFile() ? 'missing' : 'parent-not-directory'),
        (e: unknown) => {
          if (isGone(e)) return 'missing';
          if (isDenied(e)) return 'unreadable';
          throw ioError(e, 'reading the design folder');
        },
      );
      parents.set(prefix, verdict);
    }
    return verdict;
  };

  return mapLimit(
    paths,
    CONCURRENCY,
    async (rel): Promise<PathInspection> => {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const v = await checkDir(parts.slice(0, i).join('/'));
        if (v === 'missing') return { kind: 'missing' };
        if (v !== 'ok') return { kind: 'unsupported', reason: v };
      }
      let st: BigIntStats;
      try {
        st = await lstat(join(root, rel), { bigint: true });
      } catch (e) {
        if (isGone(e)) return { kind: 'missing' };
        if (isDenied(e) || (e as NodeJS.ErrnoException).code === 'ENAMETOOLONG') {
          return { kind: 'unsupported', reason: 'unreadable' };
        }
        throw ioError(e, 'reading the design folder');
      }
      if (st.isSymbolicLink()) return { kind: 'unsupported', reason: 'symlink' };
      // A tracked file replaced by a folder: Git sees a deletion (and the
      // folder's files as new).
      if (st.isDirectory()) return { kind: 'missing' };
      if (!st.isFile()) return { kind: 'unsupported', reason: 'special' };
      return {
        kind: 'file',
        size: Number(st.size),
        // Git records 100755 when the owner may execute (core.fileMode=true).
        executable: (st.mode & 0o100n) !== 0n,
        identity: { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs },
      };
    },
    signal,
  );
}
