// Remote sync (M1-07) on real Git, a real filesystem and real SQLite, against
// a fake GitHub on loopback (device flow, API, smart-HTTP Git). Each harness
// is one computer: its own data store and Engine core, wired as the Engine
// wires them, with the GitHub provider on an in-memory vault. Two harnesses
// on one fake GitHub are two computers syncing one project.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DtError,
  EngineInstanceId,
  type Channel,
  type EngineEvent,
  type OperationName,
  type OperationOutput,
  type ProjectId,
} from '@draft-tide/contracts';
import { createEngineCore, type EngineCore, type TestHooks } from '@draft-tide/core';
import { openLocalStore, type LocalStoreHandle } from '@draft-tide/local-store';
import { createGitHubProvider, createMemoryVault, parseTestEndpoints } from '@draft-tide/remote-github';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../fixtures/fake-github.ts';
import {
  cleanupTempDirs,
  committedRepo,
  gitRuntime,
  gitStatus,
  plainGit,
  plainGitEnv,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { createProjectHost } from '../src/engine/host.ts';

const stores: LocalStoreHandle[] = [];
const cores: EngineCore[] = [];
let gh: FakeGitHub;

beforeAll(async () => {
  gh = await startFakeGitHub({ rootDir: tempDir('dt-fakegh-') });
});

afterAll(async () => {
  for (const c of cores.splice(0)) c.stop();
  for (const s of stores.splice(0)) s.close();
  await gh.close();
  cleanupTempDirs();
});

interface Harness {
  core: EngineCore;
  store: LocalStoreHandle;
  dataDir: string;
  events: EngineEvent[];
  call<N extends OperationName>(op: N, payload: unknown, channel?: Channel): Promise<OperationOutput<N>>;
  at: Map<string, (detail?: { path?: string; index?: number }) => void | Promise<void>>;
}

async function computer(): Promise<Harness> {
  const dataDir = tempDir('dt-sync-data-');
  const store = await openLocalStore({ dataDir });
  stores.push(store);
  const events: EngineEvent[] = [];
  const at = new Map<string, (detail?: { path?: string; index?: number }) => void | Promise<void>>();
  const testHooks: TestHooks = { checkpoint: async (point, detail) => at.get(point)?.(detail) };
  const core = createEngineCore(
    {
      clock: { nowIso: () => new Date().toISOString() },
      store,
      events: { publish: (e) => events.push(e) },
      identity: {
        instanceId: EngineInstanceId.parse(randomUUID()),
        appVersion: '0.0.0-test',
        startedAt: new Date().toISOString(),
        desktopIdentity: 'development',
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
      },
      host: createProjectHost({ dataDir, git: gitRuntime() }),
      remote: createGitHubProvider({
        clientId: 'Iv23-test',
        appSlug: 'draft-tide-test',
        endpoints: parseTestEndpoints(gh.env),
        vault: createMemoryVault(),
        userAgent: 'DraftTide/test',
      }),
    },
    { retryDelayMs: () => 1, lockWaitMs: 50, testHooks },
  );
  cores.push(core);
  await core.startup();
  return {
    core,
    store,
    dataDir,
    events,
    at,
    call: (op, payload, channel = 'desktop') => core.handle(channel, op, payload) as never,
  };
}

async function refusal(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function signIn(h: Harness): Promise<void> {
  const started = await h.call('auth.loginStart', {});
  expect(started.state).toBe('signing-in');
  expect(started.login?.userCode).toBeTruthy();
  await until(
    'sign-in',
    () => h.call('auth.status', {}),
    (s) => s.state === 'signed-in',
  );
}

async function connectFolder(h: Harness, root: string): Promise<ProjectId> {
  const r = await h.call('project.review', { root });
  const { project } = await h.call('project.bind', { root, name: 'Site', entryFiles: [], reviewToken: r.reviewToken });
  await h.call('snapshot.create', { projectId: project.projectId });
  return project.projectId;
}

async function connectRemote(h: Harness, projectId: ProjectId, name: string, setOrigin = true) {
  const plan = await h.call('remote.connectPlan', { projectId, repo: { owner: 'designer', name } });
  return { plan, result: await h.call('remote.connectApply', { projectId, planId: plan.planId, setOrigin }) };
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();

// The user's own Git over the network, asynchronously: the fake GitHub lives
// in this process, and a synchronous spawn would block it.
function plainGitAsync(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...plainGitEnv(), GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

// Every file under dir whose bytes contain any of the tokens.
function leaks(dir: string, tokens: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const bytes = readFileSync(p);
        if (tokens.some((t) => bytes.includes(t))) out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

describe('signing in', () => {
  it('signs in through the device flow; new versions carry the user, a login request is answered', async () => {
    const h = await computer();
    const before = await h.call('auth.status', {});
    expect(before).toMatchObject({ state: 'signed-out', user: null, identity: { name: 'Draft Tide' } });
    // The tool channel may only ask (agent access on).
    await h.call('agentAccess.set', { enabled: true });
    const asked = await refusal(h.call('auth.loginRequest', {}, 'cli'));
    expect(asked.code).toBe('CONFIRMATION_REQUIRED');
    const requestId = asked.details['operationId'] as string;
    expect((await refusal(h.call('auth.loginStart', {}, 'cli'))).code).toBe('UNKNOWN_OPERATION');

    await signIn(h);
    const status = await h.call('auth.status', {});
    expect(status.user).toEqual(gh.user);
    expect(status.identity).toEqual({
      name: 'Dee Signer',
      email: `${gh.user.id}+${gh.user.login}@users.noreply.github.com`,
    });
    expect(h.events).toContainEqual({ name: 'auth.changed', login: 'completed' });
    expect(await h.call('operation.status', { operationId: requestId }, 'cli')).toMatchObject({
      kind: 'login-request',
      state: 'completed',
      user: gh.user,
    });
    // The tool channel sees who, never the device code.
    expect((await h.call('auth.status', {}, 'cli')).login).toBeNull();
    expect((await refusal(h.call('auth.loginRequest', {}, 'cli'))).details['reason']).toBe('already-signed-in');

    const root = committedRepo({ 'index.html': 'v1\n' });
    const projectId = await connectFolder(h, root);
    write(root, 'index.html', 'v2\n');
    await h.call('snapshot.create', { projectId });
    expect(plainGit(root, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).trim()).toBe(
      `Dee Signer <${gh.user.id}+designer@users.noreply.github.com>|Dee Signer <${gh.user.id}+designer@users.noreply.github.com>`,
    );

    await h.call('auth.logout', {});
    expect(await h.call('auth.status', {})).toMatchObject({ state: 'signed-out', identity: { name: 'Draft Tide' } });
  });
});

describe('connecting a repository and pushing', () => {
  it('reviews and makes the first push into an empty repository, then pushes each save in the background', async () => {
    gh.createRepo('designer', 'site');
    const h = await computer();
    await signIn(h);
    const root = committedRepo({ 'index.html': '<h1>v1</h1>\n' });
    write(root, 'config.js', 'const key = "ghp_0123456789abcdefghijABCDEFGHIJ012345";\n');
    write(root, 'img/a.png', Buffer.alloc(3000, 1));
    const projectId = await connectFolder(h, root);
    expect((await h.call('remote.status', { projectId })).state).toBe('not-connected');

    const { plan, result } = await connectRemote(h, projectId, 'site');
    expect(plan).toMatchObject({ relation: 'empty', branch: 'main', blocked: null, remoteTip: null });
    expect(plan.repo).toMatchObject({ owner: 'designer', name: 'site', visibility: 'private' });
    expect(plan.review?.versions).toBe(1);
    expect(plan.review?.commits).toBe(2);
    expect(plan.review?.suspectedSecrets.sample).toContain('config.js');
    expect(plan.review?.largest[0]).toEqual({ path: 'img/a.png', size: 3000 });
    expect(plan.origin).toEqual({ url: null, matches: false });

    expect(result.push).toMatchObject({ outcome: 'pushed', commits: 2, commit: head(root) });
    expect(result.status).toMatchObject({ state: 'synced', ahead: 0, behind: 0 });
    expect(result.originSet).toBe(true);
    expect(gh.branchTip('designer', 'site', 'main')).toBe(head(root));
    expect(plainGit(root, ['config', '--get', 'remote.origin.url']).trim()).toBe(
      `${gh.endpoints.git}/designer/site.git`,
    );
    expect(gitStatus(root)).toBe('');

    // A save is pushed after it returns, never as part of it.
    write(root, 'index.html', '<h1>v2</h1>\n');
    await h.call('snapshot.create', { projectId });
    await until(
      'the background push',
      () => h.call('remote.status', { projectId }),
      (s) => s.state === 'synced' && s.localTip === head(root),
    );
    expect(gh.branchTip('designer', 'site', 'main')).toBe(head(root));

    // An engineer's plain clone has the whole history and a clean folder.
    const clone = tempDir('dt-clone-');
    const token = gh.issueAccessToken();
    const url = `${gh.endpoints.git}/designer/site.git`.replace('http://', `http://x-access-token:${token}@`);
    expect(await plainGitAsync(clone, ['clone', '--quiet', url, 'site'])).toBe(0);
    expect(plainGit(join(clone, 'site'), ['rev-parse', 'HEAD']).trim()).toBe(head(root));
    expect(read(join(clone, 'site'), 'index.html')).toBe('<h1>v2</h1>\n');
    expect(gitStatus(join(clone, 'site'))).toBe('');

    // No token in the data directory (SQLite included) or the project's .git.
    expect(leaks(h.dataDir, gh.tokens)).toEqual([]);
    expect(leaks(join(root, '.git'), gh.tokens)).toEqual([]);
    expect(JSON.stringify(h.events)).not.toMatch(/gh[ur]_/);
  });

  it('refuses a repository with a history of its own, and changes nothing', async () => {
    const repo = gh.createRepo('designer', 'with-readme');
    const other = committedRepo({ 'README.md': '# made on GitHub\n' });
    plainGit(other, ['push', '--quiet', repo.dir, 'HEAD:refs/heads/main']);
    const before = gh.branchTip('designer', 'with-readme', 'main');
    const h = await computer();
    await signIn(h);
    const root = committedRepo();
    const projectId = await connectFolder(h, root);
    const plan = await h.call('remote.connectPlan', { projectId, repo: { owner: 'designer', name: 'with-readme' } });
    expect(plan).toMatchObject({
      relation: 'unrelated',
      blocked: { code: 'REMOTE_DIVERGED', reason: 'unrelated-history' },
    });
    const e = await refusal(h.call('remote.connectApply', { projectId, planId: plan.planId, setOrigin: true }));
    expect({ code: e.code, reason: e.details['reason'] }).toEqual({
      code: 'REMOTE_DIVERGED',
      reason: 'unrelated-history',
    });
    expect(gh.branchTip('designer', 'with-readme', 'main')).toBe(before);
    expect((await h.call('remote.status', { projectId })).state).toBe('not-connected');
    expect(() => plainGit(root, ['config', '--get', 'remote.origin.url'])).toThrow();
  });

  it('needs the app installed, and the user signed in; saving never waits for either', async () => {
    gh.createRepo('designer', 'gated');
    const h = await computer();
    await signIn(h);
    const root = committedRepo();
    const projectId = await connectFolder(h, root);
    gh.setInstalled('designer', 'gated', false);
    const e = await refusal(h.call('remote.connectPlan', { projectId, repo: { owner: 'designer', name: 'gated' } }));
    expect({ code: e.code, reason: e.details['reason'] }).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
    gh.setInstalled('designer', 'gated', true);
    await connectRemote(h, projectId, 'gated');

    // Uninstalled later: the push is refused with the reason, nothing local changes.
    gh.setInstalled('designer', 'gated', false);
    write(root, 'index.html', 'offline edit\n');
    await h.call('snapshot.create', { projectId });
    const rejected = await until(
      'the refusal',
      () => h.call('remote.status', { projectId }),
      (s) => s.state === 'rejected',
    );
    expect(rejected.lastError).toMatchObject({ code: 'REMOTE_REJECTED', reason: 'app-not-installed' });
    gh.setInstalled('designer', 'gated', true);
    expect(await h.call('sync.push', { projectId })).toMatchObject({ outcome: 'pushed' });
    expect((await h.call('remote.status', { projectId })).state).toBe('synced');

    // Signed out: saves work, the push waits for a sign-in, then runs.
    await h.call('auth.logout', {});
    write(root, 'index.html', 'signed out edit\n');
    await h.call('snapshot.create', { projectId });
    await until(
      'needs-sign-in',
      () => h.call('remote.status', { projectId }),
      (s) => s.state === 'needs-sign-in',
    );
    expect((await refusal(h.call('sync.push', { projectId }))).code).toBe('AUTH_REQUIRED');
    await signIn(h);
    await until(
      'the push after sign-in',
      () => h.call('remote.status', { projectId }),
      (s) => s.state === 'synced',
    );
    expect(gh.branchTip('designer', 'gated', 'main')).toBe(head(root));
  });
});

describe('two computers', () => {
  it('opens the project from GitHub elsewhere, then fast-forwards each other', async () => {
    gh.createRepo('designer', 'shared');
    const a = await computer();
    const b = await computer();
    await signIn(a);
    await signIn(b);
    const rootA = committedRepo({ 'index.html': 'one\n', 'img/x.png': Buffer.alloc(10, 2) });
    const projectId = await connectFolder(a, rootA);
    await connectRemote(a, projectId, 'shared');

    // Open on computer B, into a folder that doesn't exist yet.
    const parent = tempDir('dt-open-');
    const rootB = join(parent, 'site');
    await b.call('agentAccess.set', { enabled: true });
    const openPlan = await b.call(
      'remote.openPlan',
      { repo: { owner: 'designer', name: 'shared' }, destination: rootB },
      'cli',
    );
    expect(openPlan).toMatchObject({ branch: 'main', tip: head(rootA), destination: { exists: false }, blocked: null });
    const opened = await b.call('remote.openApply', { planId: openPlan.planId }, 'cli');
    expect(opened).toMatchObject({ project: { projectId, root: rootB }, files: 3, relinked: false });
    expect(head(rootB)).toBe(head(rootA));
    expect(read(rootB, 'index.html')).toBe('one\n');
    expect(gitStatus(rootB)).toBe('');
    expect(await b.call('remote.status', { projectId })).toMatchObject({ state: 'synced', remote: { name: 'shared' } });
    expect((await b.call('history.list', { projectId })).versions).toBe(1);

    // B saves and pushes; A gets it.
    write(rootB, 'index.html', 'two from B\n');
    write(rootB, 'new.txt', 'new\n');
    await b.call('snapshot.create', { projectId });
    await b.call('sync.push', { projectId });
    const plan = await a.call('sync.pullPlan', { projectId });
    expect(plan).toMatchObject({ relation: 'behind', incoming: 1, blocked: null, noop: false });
    expect(plan.summary).toEqual({ overwrite: 1, add: 1, delete: 0, unchanged: 2 });
    const pulled = await a.call('sync.pullApply', { projectId, planId: plan.planId });
    expect(pulled).toMatchObject({ written: 2, deleted: 0, to: { commit: head(rootB) } });
    expect(head(rootA)).toBe(head(rootB));
    expect(read(rootA, 'index.html')).toBe('two from B\n');
    expect(gitStatus(rootA)).toBe('');
    expect((await a.call('remote.status', { projectId })).state).toBe('synced');
    expect(await a.call('sync.pullPlan', { projectId })).toMatchObject({ relation: 'equal', noop: true });

    // Unsaved changes stop a pull before anything is written.
    write(rootB, 'index.html', 'three from B\n');
    await b.call('snapshot.create', { projectId });
    await b.call('sync.push', { projectId });
    write(rootA, 'index.html', 'unsaved on A\n');
    const blocked = await a.call('sync.pullPlan', { projectId });
    expect(blocked.blocked).toEqual({ code: 'UNSAVED_CHANGES', reason: null });
    expect((await refusal(a.call('sync.pullApply', { projectId, planId: blocked.planId }))).code).toBe(
      'UNSAVED_CHANGES',
    );
    expect(read(rootA, 'index.html')).toBe('unsaved on A\n');

    // Both have new versions now: diverged, nothing changes on either side.
    await a.call('snapshot.create', { projectId });
    const tipA = head(rootA);
    const remoteTip = gh.branchTip('designer', 'shared', 'main');
    const e = await refusal(a.call('sync.push', { projectId }));
    expect({ code: e.code, reason: e.details['reason'] }).toEqual({ code: 'REMOTE_DIVERGED', reason: 'diverged' });
    expect(gh.branchTip('designer', 'shared', 'main')).toBe(remoteTip);
    expect(head(rootA)).toBe(tipA);
    expect((await a.call('remote.status', { projectId })).state).toBe('diverged');
    const diverged = await a.call('sync.pullPlan', { projectId });
    expect(diverged).toMatchObject({ relation: 'diverged', blocked: { code: 'REMOTE_DIVERGED' }, noop: false });
    expect((await refusal(a.call('sync.pullApply', { projectId, planId: diverged.planId }))).code).toBe(
      'REMOTE_DIVERGED',
    );
    expect(head(rootA)).toBe(tipA);
  });

  it('opens only into an empty folder, and refuses a project already connected here', async () => {
    gh.createRepo('designer', 'only-empty');
    const a = await computer();
    await signIn(a);
    const root = committedRepo();
    const projectId = await connectFolder(a, root);
    await connectRemote(a, projectId, 'only-empty');
    const busy = tempDir('dt-busy-');
    writeFileSync(join(busy, 'keep.txt'), 'mine\n');
    const plan = await a.call('remote.openPlan', {
      repo: { owner: 'designer', name: 'only-empty' },
      destination: busy,
    });
    expect(plan.blocked).toEqual({ code: 'UNTRACKED_FILES', reason: 'destination-not-empty' });
    expect((await refusal(a.call('remote.openApply', { planId: plan.planId }))).code).toBe('UNTRACKED_FILES');
    expect(readdirSync(busy)).toEqual(['keep.txt']);
    // Same computer, the project's folder still there: refused, and the new
    // folder is left as it was.
    const empty = join(tempDir('dt-empty-'), 'again');
    const again = await a.call('remote.openPlan', {
      repo: { owner: 'designer', name: 'only-empty' },
      destination: empty,
    });
    expect((await refusal(a.call('remote.openApply', { planId: again.planId }))).code).toBe('PROJECT_ALREADY_BOUND');
    expect(() => readdirSync(empty)).toThrow();
    expect(a.store.getProject(projectId)?.root).toBe(root);
  });
});

describe('recovering a pull and an open that stopped part-way', () => {
  it('finishes or rolls back a pull, and finishes an open', async () => {
    gh.createRepo('designer', 'crashy');
    const a = await computer();
    const b = await computer();
    await signIn(a);
    await signIn(b);
    const rootA = committedRepo({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
    const projectId = await connectFolder(a, rootA);
    await connectRemote(a, projectId, 'crashy');

    // Open on B stops after its first file.
    const rootB = join(tempDir('dt-crash-open-'), 'site');
    const plan = await b.call('remote.openPlan', { repo: { owner: 'designer', name: 'crashy' }, destination: rootB });
    b.at.set('open:file', (d) => {
      if (d?.index === 1) throw new Error('boom');
    });
    expect((await refusal(b.call('remote.openApply', { planId: plan.planId }))).code).toBe('RECOVERY_REQUIRED');
    b.at.clear();
    // The interrupted open shows on the project's recovery card: finish only.
    const report = await b.call('recovery.inspect', { projectId });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ kind: 'open', strategies: ['finish'] });
    const finish = await b.call('recovery.plan', {
      projectId,
      operationId: report.items[0]?.operationId,
      strategy: 'finish',
    });
    await b.call('recovery.apply', { projectId, planId: finish.planId });
    expect(head(rootB)).toBe(head(rootA));
    expect(gitStatus(rootB)).toBe('');

    // A pull on A stops after its first file: finish.
    write(rootB, 'a.txt', 'a2\n');
    write(rootB, 'b.txt', 'b2\n');
    await b.call('snapshot.create', { projectId });
    await b.call('sync.push', { projectId });
    const pull = await a.call('sync.pullPlan', { projectId });
    a.at.set('pull:file', (d) => {
      if (d?.index === 1) throw new Error('boom');
    });
    const stopped = await refusal(a.call('sync.pullApply', { projectId, planId: pull.planId }));
    expect(stopped.code).toBe('RECOVERY_REQUIRED');
    a.at.clear();
    const item = (await a.call('recovery.inspect', { projectId })).items[0];
    expect(item).toMatchObject({ kind: 'pull', strategies: ['finish', 'rollback'], files: { done: 1, pending: 1 } });
    expect((await refusal(a.call('snapshot.create', { projectId }))).code).toBe('RECOVERY_REQUIRED');
    const fin = await a.call('recovery.plan', { projectId, operationId: item?.operationId, strategy: 'finish' });
    await a.call('recovery.apply', { projectId, planId: fin.planId });
    expect(head(rootA)).toBe(head(rootB));
    expect([read(rootA, 'a.txt'), read(rootA, 'b.txt')]).toEqual(['a2\n', 'b2\n']);
    expect(gitStatus(rootA)).toBe('');

    // Another one stops; roll it back: the folder and branch are as before.
    write(rootB, 'a.txt', 'a3\n');
    write(rootB, 'b.txt', 'b3\n');
    await b.call('snapshot.create', { projectId });
    await b.call('sync.push', { projectId });
    const before = head(rootA);
    const pull2 = await a.call('sync.pullPlan', { projectId });
    a.at.set('pull:file', (d) => {
      if (d?.index === 1) throw new Error('boom');
    });
    await refusal(a.call('sync.pullApply', { projectId, planId: pull2.planId }));
    a.at.clear();
    const item2 = (await a.call('recovery.inspect', { projectId })).items[0];
    const back = await a.call('recovery.plan', { projectId, operationId: item2?.operationId, strategy: 'rollback' });
    await a.call('recovery.apply', { projectId, planId: back.planId });
    expect(head(rootA)).toBe(before);
    expect([read(rootA, 'a.txt'), read(rootA, 'b.txt')]).toEqual(['a2\n', 'b2\n']);
    expect(gitStatus(rootA)).toBe('');
  });
});

describe('tokens refused by Git, reconnecting, and opening safely', () => {
  it('refreshes a token Git refused and pushes once more', async () => {
    gh.createRepo('designer', 'rotated');
    const h = await computer();
    await signIn(h);
    const root = committedRepo();
    const projectId = await connectFolder(h, root);
    await connectRemote(h, projectId, 'rotated');
    // GitHub stops honouring the access token (rotated elsewhere, say).
    gh.expireAccessTokens();
    write(root, 'index.html', 'after the token went\n');
    await h.call('snapshot.create', { projectId });
    expect(await h.call('sync.push', { projectId })).toMatchObject({ outcome: 'pushed' });
    expect(gh.branchTip('designer', 'rotated', 'main')).toBe(head(root));
    expect((await h.call('auth.status', {})).state).toBe('signed-in');
  });

  it('pushes everything to a new repository after disconnecting from another', async () => {
    gh.createRepo('designer', 'first-home');
    gh.createRepo('designer', 'second-home');
    const h = await computer();
    await signIn(h);
    const root = committedRepo();
    const projectId = await connectFolder(h, root);
    await connectRemote(h, projectId, 'first-home');
    expect((await h.call('remote.disconnect', { projectId })).state).toBe('not-connected');
    const { plan, result } = await connectRemote(h, projectId, 'second-home', false);
    expect(plan.relation).toBe('empty');
    expect(result.push).toMatchObject({ outcome: 'pushed' });
    expect(gh.branchTip('designer', 'second-home', 'main')).toBe(head(root));
    expect(result.status.state).toBe('synced');
  });

  it('opens only the user’s own repositories, never into hidden folders or another project', async () => {
    const pub = gh.createRepo('designer', 'stranger', { private: false, installed: false });
    const seed = committedRepo({ '.drafttide.json': '{}\n' });
    plainGit(seed, ['push', '--quiet', pub.dir, 'HEAD:refs/heads/main']);
    gh.createRepo('designer', 'mine');
    const h = await computer();
    await signIn(h);
    const root = committedRepo();
    const projectId = await connectFolder(h, root);
    await connectRemote(h, projectId, 'mine');
    const other = await computer();
    await signIn(other);
    await other.call('agentAccess.set', { enabled: true });

    const stranger = await refusal(
      other.call(
        'remote.openPlan',
        { repo: { owner: 'designer', name: 'stranger' }, destination: join(tempDir('dt-x-'), 'a') },
        'cli',
      ),
    );
    expect({ code: stranger.code, reason: stranger.details['reason'] }).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
    const hidden = await refusal(
      other.call(
        'remote.openPlan',
        { repo: { owner: 'designer', name: 'mine' }, destination: join(tempDir('dt-x-'), '.ssh') },
        'cli',
      ),
    );
    expect({ code: hidden.code, reason: hidden.details['reason'] }).toEqual({
      code: 'INVALID_ARGUMENT',
      reason: 'destination-not-allowed',
    });
    // Inside a connected project: refused even when applied anyway.
    const otherRoot = committedRepo();
    await connectFolder(other, otherRoot);
    const nested = await other.call(
      'remote.openPlan',
      { repo: { owner: 'designer', name: 'mine' }, destination: join(otherRoot, 'sub') },
      'cli',
    );
    expect(nested.blocked).toEqual({ code: 'REPO_UNSUPPORTED', reason: 'inside-another-repo' });
    expect((await refusal(other.call('remote.openApply', { planId: nested.planId }, 'cli'))).code).toBe(
      'REPO_UNSUPPORTED',
    );
    expect(() => readdirSync(join(otherRoot, 'sub'))).toThrow();
  });

  it('undoes an open that stops before its first file', async () => {
    gh.createRepo('designer', 'undone');
    const a = await computer();
    await signIn(a);
    const root = committedRepo();
    const projectId = await connectFolder(a, root);
    await connectRemote(a, projectId, 'undone');
    const b = await computer();
    await signIn(b);
    const parent = tempDir('dt-undo-');
    const dest = join(parent, 'site');
    const plan = await b.call('remote.openPlan', { repo: { owner: 'designer', name: 'undone' }, destination: dest });
    b.at.set('open:staged', () => {
      throw new Error('stopped');
    });
    await expect(b.call('remote.openApply', { planId: plan.planId })).rejects.toThrow('stopped');
    b.at.clear();
    expect(b.store.getProject(projectId)).toBeNull();
    expect(b.store.getRemote(projectId)).toBeNull();
    expect(readdirSync(parent)).toEqual([]);
    // The folder is free again.
    const again = await b.call('remote.openPlan', { repo: { owner: 'designer', name: 'undone' }, destination: dest });
    expect(again.blocked).toBeNull();
    await b.call('remote.openApply', { planId: again.planId });
    expect(head(dest)).toBe(head(root));
  });
});
