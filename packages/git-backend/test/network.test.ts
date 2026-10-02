import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DtError } from '@draft-tide/contracts';
import type { GitAccess } from '@draft-tide/core';
import { startFakeGitHub, type FakeGitHub } from '../../../fixtures/fake-github.ts';
import {
  classifyNetworkFailure,
  gitTrace,
  openGitRepo,
  parsePushPorcelain,
  sweepNetworkDirs,
  withNetwork,
} from '../src/index.ts';
import { cleanupTempDirs, committedRepo, gitRuntime, plainGit, plainGitEnv, tempDir, write } from './helpers.ts';

// Git's network operations against a fake GitHub (smart HTTP, Basic auth with
// x-access-token), each in an ephemeral git dir that never reads the
// project's config (M1 plan §10.5).

let gh: FakeGitHub;
let ghRoot: string;
const rt = () => gitRuntime();

beforeAll(async () => {
  ghRoot = tempDir('dt-fakegh-');
  gh = await startFakeGitHub({ rootDir: ghRoot });
});

afterAll(async () => {
  await gh.close();
  cleanupTempDirs();
});

afterEach(() => {
  gitTrace.enabled = false;
  gitTrace.argv = [];
});

function access(owner: string, name: string, token = gh.issueAccessToken()): GitAccess {
  return {
    url: `${gh.endpoints.git}/${owner}/${name}.git`,
    credential: { username: 'x-access-token', reveal: () => token },
    allowHttp: true,
  };
}

function open(root: string, tmp = tempDir('dt-net-')) {
  return { repo: openGitRepo(rt(), root, { networkTmpDir: tmp }), tmp };
}

const tip = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();

async function codeOf(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return { code: e.code, reason: e.details['reason'] };
    throw e;
  }
  throw new Error('expected a failure');
}

// Every file under dir whose bytes contain needle.
function filesContaining(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p).includes(needle)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// The user's own Git, asynchronously: the fake servers live in this process,
// so a synchronous spawn would block them.
function plainGitAsync(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...plainGitEnv(), GIT_TERMINAL_PROMPT: '0' },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

// A listener that records every request: it must stay silent. With a Basic
// challenge, a client redirected here would hand over its credentials.
async function canary(): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers['authorization'] ? 'with-credentials' : ''}`);
    req.resume();
    if (!req.headers['authorization']) res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="canary"' }).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe('push and fetch', () => {
  it('pushes into an empty repository, then fetches into another clone', async () => {
    gh.createRepo('designer', 'first');
    const root = committedRepo({ 'index.html': '<h1>v1</h1>\n', 'img/a.png': Buffer.from([1, 2, 3]) });
    const { repo, tmp } = open(root);
    const a = access('designer', 'first');
    expect((await repo.remoteHeads(a)).size).toBe(0);
    gitTrace.enabled = true;
    const commit = tip(root);
    expect(await repo.pushBranch(a, 'main', commit)).toEqual({ created: true });
    expect(gh.branchTip('designer', 'first', 'main')).toBe(commit);
    expect(await repo.trackingTip('main')).toBe(commit);
    expect(await repo.remoteHeads(a)).toEqual(new Map([['refs/heads/main', commit]]));
    // Pushing the same commit again changes nothing.
    expect(await repo.pushBranch(a, 'main', commit)).toEqual({ created: false });

    // Token hygiene: never in argv, `.git`, or left in the data dir.
    const secret = a.credential?.reveal() as string;
    expect(gitTrace.argv.flat().some((arg) => arg.includes(secret))).toBe(false);
    expect(filesContaining(join(root, '.git'), secret)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);

    const other = tempDir('dt-other-');
    plainGit(other, ['init', '--quiet']);
    const { repo: theirs } = open(other);
    expect(await theirs.fetchBranch(a, 'main')).toBe(commit);
    expect(await theirs.trackingTip('main')).toBe(commit);
    expect(await theirs.fetchBranch(a, 'nope')).toBeNull();
  });

  it('refuses a non-fast-forward push and changes nothing on GitHub', async () => {
    gh.createRepo('designer', 'race');
    const a = access('designer', 'race');
    const mine = committedRepo({ 'a.txt': 'base\n' });
    const { repo } = open(mine);
    const base = tip(mine);
    await repo.pushBranch(a, 'main', base);
    // Someone else pushes on top of the base.
    const theirs = tempDir('dt-theirs-');
    plainGit(theirs, ['init', '--quiet']);
    const { repo: other } = open(theirs);
    await other.fetchBranch(a, 'main');
    plainGit(theirs, ['reset', '--quiet', '--hard', 'refs/remotes/draft-tide/main']);
    write(theirs, 'b.txt', 'theirs\n');
    plainGit(theirs, ['add', '-A']);
    plainGit(theirs, ['commit', '--quiet', '-m', 'theirs']);
    await other.pushBranch(a, 'main', tip(theirs));
    // This folder adds its own version on the old base.
    write(mine, 'c.txt', 'mine\n');
    plainGit(mine, ['add', '-A']);
    plainGit(mine, ['commit', '--quiet', '-m', 'mine']);
    expect(await codeOf(repo.pushBranch(a, 'main', tip(mine)))).toEqual({
      code: 'REMOTE_DIVERGED',
      reason: 'diverged',
    });
    expect(gh.branchTip('designer', 'race', 'main')).toBe(tip(theirs));
    // The histories share the base; another root shares nothing.
    await repo.fetchBranch(a, 'main');
    expect(await repo.mergeBase(tip(mine), tip(theirs))).toBe(base);
    const unrelated = committedRepo({ 'z.txt': 'z\n' });
    const { repo: u } = open(unrelated);
    await u.fetchBranch(a, 'main');
    expect(await u.mergeBase(tip(unrelated), tip(theirs))).toBeNull();
  });

  it('says why GitHub refused: its rules, a file over its limit', async () => {
    gh.createRepo('designer', 'rules');
    const a = access('designer', 'rules');
    const root = committedRepo();
    const { repo } = open(root);
    gh.rejectPushes('designer', 'rules', 'protected-branch');
    expect(await codeOf(repo.pushBranch(a, 'main', tip(root)))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'protected-branch',
    });
    gh.rejectPushes('designer', 'rules', 'large-file');
    expect(await codeOf(repo.pushBranch(a, 'main', tip(root)))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'file-too-large',
    });
    gh.rejectPushes('designer', 'rules', null);
    expect(gh.branchTip('designer', 'rules', 'main')).toBeNull();
  });

  it('tells a bad token, a missing app and an unreachable host apart', async () => {
    gh.createRepo('designer', 'gone', { installed: false });
    gh.createRepo('designer', 'auth');
    const root = committedRepo();
    const { repo, tmp } = open(root);
    expect(await codeOf(repo.pushBranch(access('designer', 'auth', 'ghu_notavalidtoken'), 'main', tip(root)))).toEqual({
      code: 'AUTH_REQUIRED',
      reason: 'expired',
    });
    expect(await codeOf(repo.fetchBranch(access('designer', 'gone'), 'main'))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
    const dead: GitAccess = { ...access('designer', 'auth'), url: 'http://127.0.0.1:9/designer/auth.git' };
    expect(await codeOf(repo.remoteHeads(dead))).toEqual({ code: 'NETWORK_UNAVAILABLE', reason: 'unreachable' });
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('refuses anything but plain https (or the test GitHub on loopback)', async () => {
    const root = committedRepo();
    const { repo } = open(root);
    for (const url of [
      `${gh.endpoints.git}/designer/x.git`,
      'https://x-access-token:ghu_x@github.com/a/b.git',
      'file:///tmp/x.git',
      'ssh://github.com/a/b.git',
    ]) {
      const a: GitAccess = { url, credential: null, allowHttp: false };
      await expect(repo.remoteHeads(a), url).rejects.toThrow(DtError);
    }
  });
});

describe('the repository config is never read for network operations', () => {
  it('ignores insteadOf, proxies, extra headers and credential helpers that a control obeys', async () => {
    gh.createRepo('designer', 'hostile');
    const trap = await canary();
    try {
      const root = committedRepo();
      const gitUrl = `${gh.endpoints.git}/designer/hostile.git`;
      for (const [k, v] of [
        [`url.${trap.url}/.insteadOf`, `${gh.endpoints.git}/`],
        ['http.proxy', trap.url],
        ['http.extraHeader', 'X-Leak: yes'],
        ['credential.helper', '!f() { echo username=leak; echo password=leak; }; f'],
        ['core.sshCommand', 'false'],
        ['remote.origin.url', gitUrl],
      ] as const) {
        plainGit(root, ['config', '--add', k, v]);
      }
      // Control: the user's own Git with the repo's config goes to the trap.
      await plainGitAsync(root, ['push', gitUrl, 'HEAD:refs/heads/main']);
      expect(trap.hits.length).toBeGreaterThan(0);
      trap.hits.length = 0;

      const { repo } = open(root);
      const a = access('designer', 'hostile');
      await repo.pushBranch(a, 'main', tip(root));
      await repo.fetchBranch(a, 'main');
      expect(trap.hits).toEqual([]);
      expect(gh.branchTip('designer', 'hostile', 'main')).toBe(tip(root));
      const extra = gh.requests.filter((r) => r.path.includes('/hostile.git/') && r.token === 'leak');
      expect(extra).toEqual([]);
    } finally {
      await trap.close();
    }
  });
});

describe('what a push sends', () => {
  it('lists the objects the remote lacks, with paths and sizes', async () => {
    const root = committedRepo({ 'index.html': 'one\n', 'big.bin': Buffer.alloc(1000, 7) });
    const first = tip(root);
    write(root, 'index.html', 'two\n');
    write(root, 'new.txt', 'new\n');
    plainGit(root, ['add', '-A']);
    plainGit(root, ['commit', '--quiet', '-m', 'second']);
    const { repo } = open(root);
    const all = await repo.objectsToPush(tip(root), []);
    expect(all.filter((o) => o.type === 'commit')).toHaveLength(2);
    expect(all.find((o) => o.path === 'big.bin')).toMatchObject({ type: 'blob', size: 1000 });
    const since = await repo.objectsToPush(tip(root), [first]);
    expect(
      since
        .filter((o) => o.type === 'blob')
        .map((o) => o.path)
        .sort(),
    ).toEqual(['index.html', 'new.txt']);
    expect(await repo.commitsBetween(tip(root), [first])).toEqual([tip(root)]);
    expect(await repo.commitsBetween(tip(root), [])).toHaveLength(2);
  });
});

describe('remote.origin', () => {
  it('sets and reads it from the repo config file only', async () => {
    const root = committedRepo();
    const { repo } = open(root);
    expect(await repo.readOrigin()).toBeNull();
    await repo.setOrigin('https://github.com/designer/site.git');
    expect(await repo.readOrigin()).toBe('https://github.com/designer/site.git');
    expect(plainGit(root, ['config', '--get', 'remote.origin.fetch']).trim()).toBe(
      '+refs/heads/*:refs/remotes/origin/*',
    );
    await expect(repo.setOrigin('https://user:pw@github.com/a/b.git')).rejects.toThrow(DtError);
    await expect(repo.setOrigin('file:///etc')).rejects.toThrow(DtError);
  });
});

describe('leftovers and classification', () => {
  it('sweeps ephemeral dirs a killed Engine left (they may hold a token file)', async () => {
    const tmp = tempDir('dt-sweep-');
    mkdirSync(join(tmp, 'net-abc'));
    mkdirSync(join(tmp, 'scratch-keep'));
    expect(await sweepNetworkDirs(tmp)).toBe(1);
    expect(readdirSync(tmp)).toEqual(['scratch-keep']);
  });

  it('removes its ephemeral dir even when the operation throws', async () => {
    const tmp = tempDir('dt-throw-');
    await expect(
      withNetwork(rt(), tmp, null, access('designer', 'x'), () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(readdirSync(tmp)).toEqual([]);
    expect(statSync(tmp).isDirectory()).toBe(true);
  });

  it("reads Git's porcelain and stderr into stable codes", () => {
    expect(
      parsePushPorcelain('To x\n!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\nDone\n'),
    ).toEqual([{ flag: '!', summary: '[rejected] (non-fast-forward)' }]);
    expect(parsePushPorcelain('*\tabc:refs/heads/main\t[new branch]\n')[0]?.flag).toBe('*');
    for (const [stderr, code, reason] of [
      ['fatal: unable to access: Could not resolve host: github.com', 'NETWORK_UNAVAILABLE', 'unreachable'],
      ['error: RPC failed; curl 28 Operation timed out', 'NETWORK_UNAVAILABLE', 'timeout'],
      ['fatal: unable to access: SSL certificate problem', 'NETWORK_UNAVAILABLE', 'tls'],
      ['fatal: Authentication failed for', 'AUTH_REQUIRED', 'expired'],
      ['remote: Repository not found.', 'REMOTE_REJECTED', 'app-not-installed'],
      ['The requested URL returned error: 403', 'REMOTE_REJECTED', 'no-push-access'],
      ['The requested URL returned error: 502', 'NETWORK_UNAVAILABLE', 'server-error'],
    ] as const) {
      const e = classifyNetworkFailure(stderr);
      expect({ code: e?.code, reason: e?.details['reason'] }, stderr).toEqual({ code, reason });
    }
    expect(classifyNetworkFailure('something else')).toBeNull();
  });
});
