import type { Dirent } from 'node:fs';
import { lstat, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { VolumeSpace } from '@draft-tide/core';
import { ioError } from './io.ts';

// Free space for the volume holding `path`, as an unprivileged user sees it.
export async function volumeSpace(path: string): Promise<VolumeSpace> {
  try {
    const [st, fs] = await Promise.all([stat(path, { bigint: true }), statfs(path, { bigint: true })]);
    return { volume: st.dev.toString(), availableBytes: Number(fs.bavail * fs.bsize) };
  } catch (e) {
    throw ioError(e, 'checking free disk space');
  }
}

// Bytes of the regular files under dir, summed by the part classify names for
// each path (its segments relative to dir). Never follows a link; a folder
// that can't be read is skipped. Visits at most maxEntries entries
// (complete: false when it stopped there), so a huge or hostile tree can't
// keep it busy.
export async function measureTree<P extends string>(
  dir: string,
  classify: (segments: readonly string[]) => P,
  maxEntries = 200_000,
): Promise<{ bytes: Map<P, number>; complete: boolean }> {
  const bytes = new Map<P, number>();
  const stack: string[][] = [[]];
  let visited = 0;
  while (stack.length > 0) {
    const segments = stack.pop() ?? [];
    let entries: Dirent[];
    try {
      entries = await readdir(join(dir, ...segments), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > maxEntries) return { bytes, complete: false };
      const rel = [...segments, entry.name];
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        try {
          const st = await lstat(join(dir, ...rel));
          if (st.isFile()) {
            const part = classify(rel);
            bytes.set(part, (bytes.get(part) ?? 0) + st.size);
          }
        } catch {
          // Gone meanwhile.
        }
      }
    }
  }
  return { bytes, complete: true };
}
