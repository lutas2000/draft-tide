import { existsSync, mkdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import {
  canonicalRoot,
  createStagingArea,
  inspectDestination,
  openWorkspace,
  prepareDestination,
  removeFreshRepo,
} from '@draft-tide/adapter-filesystem';
import { DtError, OperationId, ProjectId } from '@draft-tide/contracts';
import type { ProjectHost } from '@draft-tide/core';
import { packagedLayout } from '@draft-tide/engine-client';
import {
  createScratchGitDir,
  detectExecPath,
  findGitOnPath,
  listRemoteHeads,
  openGitRepo,
  withNetwork,
  type GitRuntime,
  type HistoryTestHooks,
} from '@draft-tide/git-backend';
import type { BuildInfo } from '../build-info.ts';

// Which Git the Engine runs. Release builds use only the Git bundled with the
// app, found from the Engine executable's own place in the app's resources
// (packagedLayout), never one from PATH or the environment. It can't derive
// its exec path, so GIT_EXEC_PATH is always set for it. Development builds
// use DRAFT_TIDE_GIT or the first `git` on PATH. HOME is an empty private
// directory, so nothing personal is read.
export function engineGitRuntime(build: BuildInfo, dataDir: string, env = process.env): GitRuntime | null {
  let git: { gitPath: string; execPath: string | null } | null;
  if (build.mode === 'release') {
    git = bundledGit();
  } else {
    const gitPath = findGitOnPath(env);
    // A Git that can't find git-remote-https on its own (dugite's build) gets
    // GIT_EXEC_PATH; a system Git finds its own.
    git = gitPath ? { gitPath, execPath: detectExecPath(gitPath) } : null;
  }
  if (!git) return null;
  const homeDir = join(dataDir, 'git-home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  return { ...git, homeDir };
}

function bundledGit(): { gitPath: string; execPath: string } | null {
  if (!isSea()) return null;
  const layout = packagedLayout(dirname(dirname(process.execPath)));
  return existsSync(layout.git) ? { gitPath: layout.git, execPath: layout.gitExecPath } : null;
}

// Where network operations make their ephemeral git dirs (0700, removed after
// each; leftovers of a killed Engine are swept at start).
export function networkTmpDir(dataDir: string): string {
  return join(dataDir, 'tmp');
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
      openGitRepo(requireGit(), root, {
        networkTmpDir: networkTmpDir(dataDir),
        ...(options.gitTestHooks ? { testHooks: options.gitTestHooks } : {}),
      }),
    async openListingRepo(root) {
      const rt = requireGit();
      const scratch = await createScratchGitDir(rt, join(dataDir, 'tmp'));
      return { repo: openGitRepo(rt, root, { scratchGitDir: scratch.gitDir }), dispose: scratch.remove };
    },
    openWorkspace: (root) => openWorkspace(root),
    createStaging: (projectId, operationId) => createStagingArea(dataDir, projectId, operationId),
    remoteHeads: (access, signal) =>
      withNetwork(requireGit(), networkTmpDir(dataDir), null, access, (net) =>
        listRemoteHeads(net, access.url, signal),
      ),
    inspectDestination: (path) => inspectDestination(path, { appDataDir: dataDir }),
    prepareDestination: (path) => prepareDestination(path, { appDataDir: dataDir }),
    removeFreshRepo: (root, removeFolder) => removeFreshRepo(root, removeFolder),
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
