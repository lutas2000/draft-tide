import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError } from './errors.ts';
import { HARDENING, sanitizedEnv, spawnGit, type GitResult, type GitRuntime } from './git.ts';
import { DesignRepo } from './repo.ts';

export interface RemoteBinding {
  url: string;
  branch: string;
}

export interface Credential {
  username: string;
  token: string;
}

export interface NetOptions {
  // Product: https only. The suite runs a plain-http server on loopback.
  allowHttp?: boolean;
  // Control experiment only: run through the repository's own config instead
  // of the ephemeral git dir, to show why that is not acceptable.
  useRepoConfig?: boolean;
}

export type Relation = 'no-remote-branch' | 'equal' | 'ahead' | 'behind' | 'diverged';

const TRACK_PREFIX = 'refs/remotes/draft-tide/';
const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isSafeBranchName(b: string): boolean {
  return BRANCH_RE.test(b) && !b.endsWith('/') && !b.endsWith('.lock') && !b.endsWith('.');
}

export function trackingRef(branch: string): string {
  return `${TRACK_PREFIX}${branch}`;
}

function mapNetworkError(e: unknown): never {
  if (!(e instanceof DtError)) throw e;
  const text = `${e.message}\n${String(e.details['stderr'] ?? '')}`;
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|error: 40[13]|HTTP 40[13]|Invalid username or password|Permission to .* denied/i.test(text)) {
    throw new DtError('AUTH_REQUIRED', 'the remote needs you to sign in again', {}, false);
  }
  if (/Could not resolve host|Failed to connect|Connection refused|timed out|Couldn't connect|Could not connect|Network is unreachable|SSL connect error|certificate/i.test(text)) {
    throw new DtError('NETWORK_UNAVAILABLE', 'the remote could not be reached; your saved versions are safe locally', {}, true);
  }
  throw e;
}

interface NetCtx {
  run(args: string[], allowExitCodes?: number[]): Promise<GitResult>;
}

// Network work never reads the project's own .git/config. A config that says
// `url.<evil>.insteadOf`, `http.proxy`, `credential.helper` or `http.extraHeader`
// could send the token somewhere else or run a program, and those keys are not
// all neutralizable from the command line. So fetch/push run in an ephemeral,
// empty git dir that only *borrows* the project's object store:
//   GIT_DIR=<ephemeral>  GIT_OBJECT_DIRECTORY=<project>/.git/objects
// Config, hooks and refs come from the ephemeral dir; objects land in the project.
async function withNet<T>(repo: DesignRepo, cred: Credential | null, opts: NetOptions, fn: (net: NetCtx) => Promise<T>): Promise<T> {
  const rt: GitRuntime = repo.rt;
  await mkdir(join(repo.dataDir, 'tmp'), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(repo.dataDir, 'tmp', 'net-')); // 0700
  try {
    await mkdir(join(dir, 'objects'));
    await mkdir(join(dir, 'refs', 'heads'), { recursive: true });
    await writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n[credential]\n\thelper =\n');
    const env: Record<string, string> = { GIT_ALLOW_PROTOCOL: opts.allowHttp ? 'http:https' : 'https' };
    if (cred) {
      const tokenFile = join(dir, 'secret');
      const script = join(dir, 'askpass.sh');
      await writeFile(tokenFile, cred.token, { mode: 0o600 });
      await writeFile(script, `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s' "$DT_ASKPASS_USER" ;;\n  Password*) cat "$DT_ASKPASS_TOKEN_FILE" ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o700 });
      env['GIT_ASKPASS'] = script;
      env['DT_ASKPASS_USER'] = cred.username;
      env['DT_ASKPASS_TOKEN_FILE'] = tokenFile;
    }
    const net: NetCtx = opts.useRepoConfig
      ? { run: (args, allow) => repo.git.run(args, { env, allowExitCodes: allow ?? [] }) }
      : {
          run: (args, allow) =>
            spawnGit(rt, [`--git-dir=${dir}`, ...HARDENING, ...args], dir, sanitizedEnv(rt, { ...env, GIT_OBJECT_DIRECTORY: join(repo.root, '.git', 'objects') }), { allowExitCodes: allow ?? [] }),
        };
    return await fn(net);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRef(repo: DesignRepo, ref: string): Promise<string | null> {
  const r = await repo.git.run(['for-each-ref', '--format=%(objectname)', ref]);
  return r.stdout.trim() || null;
}

// Fetches the remote branch into refs/remotes/draft-tide/<branch>. Returns the
// remote tip (null when the remote branch does not exist yet).
export async function fetchRemote(repo: DesignRepo, b: RemoteBinding, cred: Credential | null, opts: NetOptions = {}): Promise<string | null> {
  if (!isSafeBranchName(b.branch)) throw new DtError('CONFIG_INVALID', 'unsafe branch name');
  const probe = await repo.requireUsable();
  const known = await readRef(repo, trackingRef(b.branch));
  const fetched = await withNet(repo, cred, opts, async (net) => {
    // Seed "haves" so the server only sends what we lack.
    if (probe.tip) await net.run(['update-ref', 'refs/heads/seed-local', probe.tip]);
    if (known) await net.run(['update-ref', 'refs/heads/seed-remote', known]);
    try {
      await net.run(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', b.url, `+refs/heads/${b.branch}:refs/dt/fetched`]);
    } catch (e) {
      if (e instanceof DtError && /couldn't find remote ref/i.test(String(e.details['stderr'] ?? e.message))) return null;
      mapNetworkError(e);
    }
    const r = await net.run(['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/dt/fetched']);
    const [oid, type] = r.stdout.trim().split(' ');
    if (!oid || type !== 'commit') throw new DtError('GIT_FAILED', 'remote branch does not point at a commit');
    return oid;
  });
  if (fetched) await repo.git.run(['update-ref', trackingRef(b.branch), fetched]);
  return fetched;
}

export async function classify(repo: DesignRepo, b: RemoteBinding): Promise<Relation> {
  const probe = await repo.requireUsable();
  const remote = await readRef(repo, trackingRef(b.branch));
  if (!remote) return 'no-remote-branch';
  if (!probe.tip) return 'behind';
  if (probe.tip === remote) return 'equal';
  if (await repo.isAncestor(remote, probe.tip)) return 'ahead';
  if (await repo.isAncestor(probe.tip, remote)) return 'behind';
  return 'diverged';
}

export async function pushBranch(repo: DesignRepo, b: RemoteBinding, cred: Credential | null, opts: NetOptions = {}): Promise<{ pushed: string; created: boolean }> {
  if (!isSafeBranchName(b.branch)) throw new DtError('CONFIG_INVALID', 'unsafe branch name');
  const probe = await repo.requireUsable();
  if (!probe.tip) throw new DtError('NO_CHANGES', 'nothing saved yet');
  const tip = probe.tip;
  const result = await withNet(repo, cred, opts, async (net) => {
    let r: GitResult;
    try {
      // No "+" and no --force: a non-fast-forward is refused, never overwritten.
      r = await net.run(['push', '--porcelain', '--no-verify', '--no-recurse-submodules', b.url, `${tip}:refs/heads/${b.branch}`], [1]);
    } catch (e) {
      mapNetworkError(e);
    }
    const lines = r.stdout.split('\n').filter((l) => l.includes('\t'));
    const rejected = lines.find((l) => l.startsWith('!'));
    if (rejected) {
      if (/non-fast-forward|fetch first/i.test(rejected)) throw new DtError('REMOTE_DIVERGED', 'the remote has versions you do not have; nothing was overwritten', {}, false);
      throw new DtError('REMOTE_REJECTED', `the remote refused the push: ${rejected.split('\t')[2] ?? ''}`.trim());
    }
    if (r.exitCode !== 0) {
      try {
        mapNetworkError(new DtError('GIT_FAILED', r.stderr, { stderr: r.stderr }));
      } catch (e) {
        if (e instanceof DtError && e.code !== 'GIT_FAILED') throw e;
      }
      throw new DtError('GIT_FAILED', `push failed: ${r.stderr.trim().slice(0, 300)}`);
    }
    return { created: lines.some((l) => l.startsWith('*')) };
  });
  await repo.git.run(['update-ref', trackingRef(b.branch), tip]);
  return { pushed: tip, created: result.created };
}

// Deletes a remote branch. Only used by the GitHub check script to clean up the
// throwaway branch it created itself.
export async function deleteRemoteBranch(repo: DesignRepo, b: RemoteBinding, cred: Credential | null, opts: NetOptions = {}): Promise<void> {
  if (!isSafeBranchName(b.branch)) throw new DtError('CONFIG_INVALID', 'unsafe branch name');
  await withNet(repo, cred, opts, async (net) => {
    try {
      await net.run(['push', '--porcelain', '--no-verify', b.url, `:refs/heads/${b.branch}`]);
    } catch (e) {
      mapNetworkError(e);
    }
  });
  await repo.git.run(['update-ref', '-d', trackingRef(b.branch)]);
}

export async function pull(repo: DesignRepo, b: RemoteBinding, cred: Credential | null, opts: NetOptions = {}): Promise<{ relation: Relation; fastForwarded: boolean }> {
  await fetchRemote(repo, b, cred, opts);
  const relation = await classify(repo, b);
  if (relation === 'diverged') throw new DtError('REMOTE_DIVERGED', 'you and the remote both have new versions; nothing was changed', { relation });
  if (relation === 'behind') {
    const remote = await readRef(repo, trackingRef(b.branch));
    if (!remote) throw new DtError('GIT_FAILED', 'tracking ref vanished');
    await repo.fastForward(remote);
    return { relation, fastForwarded: true };
  }
  return { relation, fastForwarded: false };
}

// "Open this project from a remote": the recovery path that replaces backup
// import. dest must be empty or absent.
export async function cloneFromRemote(rt: GitRuntime, dataDir: string, dest: string, b: RemoteBinding, cred: Credential | null, opts: NetOptions = {}): Promise<DesignRepo> {
  await mkdir(dest, { recursive: true });
  if ((await readdir(dest)).length) throw new DtError('UNTRACKED_FILES', 'destination folder is not empty');
  await spawnGit(rt, ['init', '--quiet', `--initial-branch=${b.branch}`, '--template=', dest], dest, sanitizedEnv(rt));
  const repo = new DesignRepo(rt, dataDir, dest);
  const tip = await fetchRemote(repo, b, cred, opts);
  if (!tip) throw new DtError('PROJECT_NOT_BOUND', 'the remote has no saved versions on this branch');
  await repo.fastForward(tip);
  await repo.git.run(['config', '--local', 'remote.origin.url', b.url]);
  await repo.git.run(['config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  return repo;
}

export const newId = (): string => randomUUID();
