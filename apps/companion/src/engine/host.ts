import { mkdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalRoot, createStagingArea, openWorkspace } from '@draft-tide/adapter-filesystem';
import { DtError, OperationId, ProjectId } from '@draft-tide/contracts';
import type { ProjectHost } from '@draft-tide/core';
import {
  createScratchGitDir,
  findGitOnPath,
  openGitRepo,
  type GitRuntime,
  type HistoryTestHooks,
} from '@draft-tide/git-backend';
import type { BuildInfo } from '../build-info.ts';

// Which Git the Engine runs. Release builds use only the Git bundled with the
// app (M1-09 packages it), never one from PATH; until then they have none.
// Development builds use DRAFT_TIDE_GIT or the first `git` on PATH. HOME is an
// empty private directory, so nothing personal is read.
export function engineGitRuntime(build: BuildInfo, dataDir: string, env = process.env): GitRuntime | null {
  if (build.mode === 'release') return null;
  const gitPath = findGitOnPath(env);
  if (!gitPath) return null;
  const homeDir = join(dataDir, 'git-home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  return { gitPath, execPath: null, homeDir };
}

// The project port of core, wired to the adapters: canonical roots that may
// not overlap the data directory, the project's own repo, scratch git dirs and
// staging inside the data directory.
export function createProjectHost(options: {
  dataDir: string;
  git: GitRuntime | null;
  // Development and test builds only.
  gitTestHooks?: HistoryTestHooks;
}): ProjectHost {
  const { dataDir, git } = options;
  const requireGit = (): GitRuntime => {
    if (!git) throw new DtError('GIT_FAILED', 'Git is not available to Draft Tide', { reason: 'git-missing' });
    return git;
  };
  return {
    canonicalRoot: (path) => canonicalRoot(path, { appDataDir: dataDir }),
    openRepo: (root) =>
      openGitRepo(requireGit(), root, options.gitTestHooks ? { testHooks: options.gitTestHooks } : {}),
    async openListingRepo(root) {
      const rt = requireGit();
      const scratch = await createScratchGitDir(rt, join(dataDir, 'tmp'));
      return { repo: openGitRepo(rt, root, { scratchGitDir: scratch.gitDir }), dispose: scratch.remove };
    },
    openWorkspace: (root) => openWorkspace(root),
    createStaging: (projectId, operationId) => createStagingArea(dataDir, projectId, operationId),
    async clearOperationData(projectId, keep) {
      if (!ProjectId.safeParse(projectId).success) throw new DtError('INTERNAL_ERROR', 'invalid project id');
      const dir = join(dataDir, 'projects', projectId, 'operations');
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const id = OperationId.safeParse(name);
        if (id.success && !keep.has(id.data)) await rm(join(dir, name), { recursive: true, force: true });
      }
    },
  };
}
