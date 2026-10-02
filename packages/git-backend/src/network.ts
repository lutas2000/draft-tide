import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError } from '@draft-tide/contracts';
import type { GitAccess, GitOid } from '@draft-tide/core';
import { runGit, type GitOutput, type RunOptions } from './process.ts';
import { HARDENING, type GitRuntime } from './runtime.ts';

// Git's network operations (M1 plan §10.3–10.5). The project's own config is
// never read for them: one line of `url.<x>.insteadOf`, `http.proxy`,
// `http.extraHeader` or `credential.helper` in `.git/config` would send the
// traffic, or the token, somewhere else, and multi-valued keys can't be
// cancelled with `-c` (single-repo spike, H-series, each against a control
// that leaks). So every fetch, push and ls-remote runs in an ephemeral empty
// git dir in the data directory (0700, removed afterwards):
//
//   GIT_DIR              the ephemeral dir: its config, hooks and refs are ours
//   GIT_OBJECT_DIRECTORY the project's objects, so what is fetched lands there
//                        and what is pushed comes from there
//   GIT_ALLOW_PROTOCOL   https (http only for the test GitHub on loopback)
//   GIT_ASKPASS          a script that prints the username and the contents
//                        of a 0600 token file; the token is never in argv,
//                        the environment, `.git` or any output
//
// The project's refs are then updated by the Engine itself, through the
// project's repo with the usual hardening: only refs/remotes/draft-tide/*.

export const TRACKING_PREFIX = 'refs/remotes/draft-tide/';
const FETCHED_REF = 'refs/dt/fetched';
const NET_DIR_PREFIX = 'net-';
// ls-remote is small; fetch and push grow with the project (no fixed
// quotas), so they have no total timeout: Git aborts a transfer that stays
// under 1 KiB/s for a minute (http.lowSpeed*), and the signal cancels.
const SMALL_TIMEOUT_MS = 2 * 60_000;
const OID = /^[0-9a-f]{40}$/;

// Settings on every network invocation, after the local hardening: no
// credential helper (the ephemeral config has none; this cancels any other),
// no redirects (a redirect to another host must never get the token), and
// GitHub's own limits on what a fetch may bring in are Git's defaults.
const NETWORK_HARDENING: readonly string[] = [
  ...HARDENING,
  ...[
    'credential.helper=',
    'http.followRedirects=false',
    'core.askPass=',
    'http.sslVerify=true',
    'http.lowSpeedLimit=1024',
    'http.lowSpeedTime=60',
  ].flatMap((s) => ['-c', s]),
];

// A branch name safe to put in a refspec as it is (contracts' BranchName).
export function isSafeBranchName(branch: string): boolean {
  return (
    branch.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock')
  );
}

function assertBranch(branch: string): void {
  if (!isSafeBranchName(branch))
    throw new DtError('INVALID_ARGUMENT', 'unsupported branch name', { reason: 'branch-name' });
}

function assertOid(oid: string): void {
  if (!OID.test(oid)) throw new DtError('INTERNAL_ERROR', 'invalid object id');
}

// Only https (or the test GitHub's loopback http) ever reaches Git, and never
// with credentials in the URL.
function assertUrl(access: GitAccess): void {
  let url: URL;
  try {
    url = new URL(access.url);
  } catch {
    throw new DtError('INTERNAL_ERROR', 'invalid remote address');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  const ok = url.protocol === 'https:' || (access.allowHttp && url.protocol === 'http:' && loopback);
  if (!ok || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new DtError('INTERNAL_ERROR', 'refusing a remote address that is not plain https');
  }
}

// What Git's stderr says about a failed transfer. Git reports every transport
// failure as exit 128 with English text (LANG=C); there is nothing else to go
// on. Ref-level outcomes of a push come from --porcelain instead.
export function classifyNetworkFailure(stderr: string): DtError | null {
  const t = stderr;
  if (/GH001|Large files detected|exceeds GitHub's file size limit/i.test(t)) {
    return new DtError('REMOTE_REJECTED', 'GitHub refused a file over its 100 MiB limit', { reason: 'file-too-large' });
  }
  if (/Repository not found|returned error: 404|not found/i.test(t)) {
    return new DtError(
      'REMOTE_REJECTED',
      "the repository wasn't found: Draft Tide's GitHub App may not be installed on it any more",
      { reason: 'app-not-installed' },
    );
  }
  if (/returned error: 403|Permission to .* denied|denied to /i.test(t)) {
    return new DtError('REMOTE_REJECTED', "Draft Tide can't push to this repository", { reason: 'no-push-access' });
  }
  if (
    /Authentication failed|returned error: 401|could not read (Username|Password)|terminal prompts disabled/i.test(t)
  ) {
    return new DtError('AUTH_REQUIRED', 'GitHub needs you to sign in again; nothing local is affected', {
      reason: 'expired',
    });
  }
  if (/returned error: 429/i.test(t)) {
    return new DtError('NETWORK_UNAVAILABLE', 'GitHub asked to wait; it is tried again later', {
      reason: 'rate-limited',
    });
  }
  if (/returned error: 5\d\d|internal server error|bad gateway|service unavailable/i.test(t)) {
    return new DtError('NETWORK_UNAVAILABLE', 'GitHub failed to answer; it is tried again later', {
      reason: 'server-error',
    });
  }
  if (/timed out|Operation too slow/i.test(t)) {
    return new DtError('NETWORK_UNAVAILABLE', "GitHub didn't answer in time; your versions are safe here", {
      reason: 'timeout',
    });
  }
  if (/SSL|certificate|TLS/i.test(t)) {
    return new DtError('NETWORK_UNAVAILABLE', "the connection to GitHub couldn't be verified", { reason: 'tls' });
  }
  if (
    /Could not resolve host|Failed to connect|Couldn't connect|Could not connect|Connection refused|Network is unreachable|Connection reset|Empty reply|unable to access/i.test(
      t,
    )
  ) {
    return new DtError('NETWORK_UNAVAILABLE', "GitHub couldn't be reached; your versions are safe here", {
      reason: 'unreachable',
    });
  }
  return null;
}

function networkError(e: unknown): never {
  if (e instanceof DtError && e.code === 'GIT_FAILED') {
    const classified = classifyNetworkFailure(e.message);
    if (classified) throw classified;
  }
  throw e;
}

export interface NetworkRunner {
  // A Git command in the ephemeral dir.
  run(args: string[], options?: RunOptions): Promise<GitOutput>;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "$DT_ASKPASS_USER" ;;
  Password*) cat "$DT_ASKPASS_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
`;

// Runs fn with Git commands in a fresh ephemeral git dir under tmpDir; the
// dir (with the token file) is removed afterwards, whatever happens.
// objectsDir: the project's object store, or null for ls-remote.
export async function withNetwork<T>(
  rt: GitRuntime,
  tmpDir: string,
  objectsDir: string | null,
  access: GitAccess,
  fn: (net: NetworkRunner) => Promise<T>,
): Promise<T> {
  assertUrl(access);
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(tmpDir, NET_DIR_PREFIX));
  try {
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    const gitDir = join(dir, 'git');
    await runGit(rt, ['init', '--quiet', '--bare', '--template=', gitDir], dir);
    const env: Record<string, string> = { GIT_ALLOW_PROTOCOL: access.allowHttp ? 'http:https' : 'https' };
    if (objectsDir !== null) env['GIT_OBJECT_DIRECTORY'] = objectsDir;
    if (access.credential) {
      const tokenFile = join(dir, 'token');
      const askpass = join(dir, 'askpass.sh');
      await writeFile(tokenFile, access.credential.reveal(), { mode: 0o600, flag: 'wx' });
      await writeFile(askpass, ASKPASS, { mode: 0o700, flag: 'wx' });
      env['GIT_ASKPASS'] = askpass;
      env['DT_ASKPASS_USER'] = access.credential.username;
      env['DT_ASKPASS_TOKEN_FILE'] = tokenFile;
    }
    const net: NetworkRunner = {
      run: (args, options = {}) =>
        runGit(rt, [`--git-dir=${gitDir}`, ...NETWORK_HARDENING, ...args], dir, {
          ...options,
          env: { ...env, ...options.env },
        }),
    };
    return await fn(net);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Ephemeral dirs a killed Engine left behind (they may hold a token file).
// Called at Engine start, before any network operation can run.
export async function sweepNetworkDirs(tmpDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(tmpDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(NET_DIR_PREFIX)) continue;
    await rm(join(tmpDir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// `ls-remote --heads`: every branch the remote has, by full ref name.
export async function listRemoteHeads(
  net: NetworkRunner,
  url: string,
  signal?: AbortSignal,
): Promise<Map<string, GitOid>> {
  let out: GitOutput;
  try {
    out = await net.run(['ls-remote', '--heads', '--end-of-options', url], { signal, timeoutMs: SMALL_TIMEOUT_MS });
  } catch (e) {
    networkError(e);
  }
  const heads = new Map<string, GitOid>();
  for (const line of out.stdout.toString('utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const oid = line.slice(0, tab);
    const ref = line.slice(tab + 1);
    if (OID.test(oid) && ref.startsWith('refs/heads/')) heads.set(ref, oid);
  }
  return heads;
}

// Fetches one branch into the ephemeral dir's FETCHED_REF and returns its
// commit (objects land in the project's store); null when there is no such
// branch. haves: commits the project has that the remote may have too, so
// only what is missing comes over.
export async function fetchRemoteBranch(
  net: NetworkRunner,
  url: string,
  branch: string,
  haves: readonly GitOid[],
  signal?: AbortSignal,
): Promise<GitOid | null> {
  assertBranch(branch);
  for (const [i, oid] of haves.entries()) {
    assertOid(oid);
    await net.run(['update-ref', `refs/heads/have-${i}`, oid], { signal });
  }
  let out: GitOutput;
  try {
    out = await net.run(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--no-auto-gc',
        '--refmap=',
        '--end-of-options',
        url,
        `+refs/heads/${branch}:${FETCHED_REF}`,
      ],
      { signal, okExitCodes: [128], timeoutMs: null },
    );
  } catch (e) {
    networkError(e);
  }
  if (out.exitCode !== 0) {
    if (/couldn't find remote ref/i.test(out.stderr)) return null;
    const classified = classifyNetworkFailure(out.stderr);
    if (classified) throw classified;
    throw new DtError(
      'GIT_FAILED',
      `git fetch failed: ${out.stderr.trim().split('\n').slice(0, 3).join(' / ').slice(0, 400)}`,
    );
  }
  const r = await net.run(['for-each-ref', '--format=%(objectname) %(objecttype)', FETCHED_REF], { signal });
  const [oid, type] = r.stdout.toString('utf8').trim().split(' ');
  if (!oid || !OID.test(oid) || type !== 'commit') {
    throw new DtError('GIT_FAILED', 'the remote branch does not point at a commit');
  }
  return oid;
}

// One line of `push --porcelain`: "<flag>\t<from>:<to>\t<summary> (<reason>)".
export interface PushLine {
  flag: string;
  summary: string;
}

export function parsePushPorcelain(stdout: string): PushLine[] {
  const lines: PushLine[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*!=])\t[^\t]*\t(.*)$/.exec(line);
    if (m) lines.push({ flag: m[1] as string, summary: m[2] as string });
  }
  return lines;
}

// A rejected ref, from its porcelain summary and Git's stderr (where GitHub
// explains its hooks' refusals).
export function classifyRejection(line: PushLine, stderr: string): DtError {
  const text = `${line.summary}\n${stderr}`;
  if (/non-fast-forward|fetch first|stale info/i.test(line.summary)) {
    return new DtError(
      'REMOTE_DIVERGED',
      "GitHub has versions this folder doesn't; nothing was overwritten on either side",
      { reason: 'diverged' },
    );
  }
  if (/GH001|Large files detected|exceeds GitHub's file size limit/i.test(text)) {
    return new DtError('REMOTE_REJECTED', 'GitHub refused a file over its 100 MiB limit', { reason: 'file-too-large' });
  }
  if (/protected branch|GH006|GH013|verified signature|rule violation/i.test(text)) {
    return new DtError('REMOTE_REJECTED', 'a rule on this GitHub branch refused the push', {
      reason: 'protected-branch',
    });
  }
  const why = line.summary.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
  return new DtError('REMOTE_REJECTED', `GitHub refused the push${why ? `: ${why}` : ''}`, { reason: 'rejected' });
}

// Pushes commit to refs/heads/<branch>: fast-forward only, no `+`, no
// --force. Returns whether the branch was created.
export async function pushRemoteBranch(
  net: NetworkRunner,
  url: string,
  branch: string,
  commit: GitOid,
  signal?: AbortSignal,
): Promise<{ created: boolean; upToDate: boolean }> {
  assertBranch(branch);
  assertOid(commit);
  let out: GitOutput;
  try {
    out = await net.run(
      [
        'push',
        // Not --quiet: it drops the porcelain lines this reads.
        '--porcelain',
        '--no-verify',
        '--no-recurse-submodules',
        '--no-signed',
        '--end-of-options',
        url,
        `${commit}:refs/heads/${branch}`,
      ],
      { signal, okExitCodes: [1, 128], timeoutMs: null },
    );
  } catch (e) {
    networkError(e);
  }
  const lines = parsePushPorcelain(out.stdout.toString('utf8'));
  const line = lines[0];
  if (!line) {
    const classified = classifyNetworkFailure(out.stderr);
    if (classified) throw classified;
    throw new DtError(
      'GIT_FAILED',
      `git push failed: ${out.stderr.trim().split('\n').slice(0, 3).join(' / ').slice(0, 400)}`,
    );
  }
  if (line.flag === '!') throw classifyRejection(line, out.stderr);
  if (line.flag === '+' || line.flag === '-') throw new DtError('INTERNAL_ERROR', 'a push forced or deleted a ref');
  return { created: line.flag === '*', upToDate: line.flag === '=' };
}
