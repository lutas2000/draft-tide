import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRoot, createStagingArea, openWorkspace } from '@draft-tide/adapter-filesystem';
import { DtError } from '@draft-tide/contracts';
import type { ProjectHost } from '@draft-tide/core';
import { createScratchGitDir, findGitOnPath, openGitRepo, type GitRuntime } from '@draft-tide/git-backend';
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
export function createProjectHost(options: { dataDir: string; git: GitRuntime | null }): ProjectHost {
  const { dataDir, git } = options;
  const requireGit = (): GitRuntime => {
    if (!git) throw new DtError('GIT_FAILED', 'Git is not available to Draft Tide', { reason: 'git-missing' });
    return git;
  };
  return {
    canonicalRoot: (path) => canonicalRoot(path, { appDataDir: dataDir }),
    openRepo: (root) => openGitRepo(requireGit(), root),
    async openListingRepo(root) {
      const rt = requireGit();
      const scratch = await createScratchGitDir(rt, join(dataDir, 'tmp'));
      return { repo: openGitRepo(rt, root, { scratchGitDir: scratch.gitDir }), dispose: scratch.remove };
    },
    openWorkspace: (root) => openWorkspace(root),
    createStaging: (projectId, operationId) => createStagingArea(dataDir, projectId, operationId),
  };
}
