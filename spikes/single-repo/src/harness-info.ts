import { RepoGit, spawnGit, sanitizedEnv, type GitRuntime } from './git.ts';

export async function gitVersionOf(rt: GitRuntime): Promise<string> {
  const r = await spawnGit(rt, ['version'], rt.homeDir, sanitizedEnv(rt));
  return r.stdout.trim();
}

export type { RepoGit };
