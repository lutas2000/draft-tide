import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError, isSafeRelativePath } from '@draft-tide/contracts';
import type { Workspace } from '@draft-tide/core';
import { readProjectConfigFile } from './config-file.ts';
import { digestFile } from './digest.ts';
import { inspectPaths } from './inspect.ts';
import { volumeSpace } from './space.ts';

function checked(rel: string): string {
  if (!isSafeRelativePath(rel)) throw new DtError('PATH_OUTSIDE_ROOT', 'not a path inside the design folder');
  return rel;
}

// The bound folder, opened at its canonical root (see canonicalRoot).
export function openWorkspace(root: string): Workspace {
  return {
    root,
    readProjectConfig: () => readProjectConfigFile(root),
    inspect: async (paths, signal) => inspectPaths(root, paths.map(checked), signal),
    hash: async (path, expected, signal) => digestFile(root, checked(path), expected, null, signal),
    stage: async (path, expected, dest, signal) => digestFile(root, checked(path), expected, dest, signal),
    async projectSpace() {
      // New objects go into `.git`; a folder that isn't a repo yet gets one here.
      const gitDir = join(root, '.git');
      const isDir = await lstat(gitDir).then(
        (st) => st.isDirectory(),
        () => false,
      );
      return volumeSpace(isDir ? gitDir : root);
    },
  };
}
