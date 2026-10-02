// Restoring versions (M1-05) on real Git, a real filesystem and a real SQLite
// journal: the Engine's core and adapters wired as the Engine wires them, in
// this process, so a test can pause at a named point and change the folder or
// the repo there (an external writer, an external commit, access turned
// off). Crashes are in crash-recovery.test.ts, against the Engine process.
// What the user's own Git sees is checked with plain Git (M1 plan §13.1).
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DtError,
  EngineInstanceId,
  PROJECT_CONFIG_FILE,
  type Channel,
  type EngineEvent,
  type OperationName,
  type OperationOutput,
  type ProjectId,
} from '@draft-tide/contracts';
import { createEngineCore, type EngineCore, type TestHooks } from '@draft-tide/core';
import { openLocalStore, type LocalStoreHandle } from '@draft-tide/local-store';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  gitRuntime,
  gitStatus,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { createProjectHost } from '../src/engine/host.ts';

const onWindows = process.platform === 'win32';
const stores: LocalStoreHandle[] = [];
afterAll(() => {
  for (const s of stores.splice(0)) s.close();
  cleanupTempDirs();
});

interface Harness {
  core: EngineCore;
  store: LocalStoreHandle;
  events: EngineEvent[];
  call<N extends OperationName>(op: N, payload: unknown, channel?: Channel): Promise<OperationOutput<N>>;
  // Points the next run stops at: the function runs there (and may throw).
  at: Map<string, (detail?: { path?: string; index?: number }) => void | Promise<void>>;
}

async function harness(options: { planTtlMs?: number } = {}): Promise<Harness> {
  const dataDir = tempDir('dt-restore-data-');
  const store = await openLocalStore({ dataDir });
  stores.push(store);
  const events: EngineEvent[] = [];
  const at = new Map<string, (detail?: { path?: string; index?: number }) => void | Promise<void>>();
  const testHooks: TestHooks = {
    checkpoint: async (point, detail) => {
      await at.get(point)?.(detail);
    },
  };
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
    },
    { retryDelayMs: () => 1, lockWaitMs: 50, testHooks, ...options },
  );
  return {
    core,
    store,
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

async function connect(h: Harness, root: string): Promise<ProjectId> {
  const r = await h.call('project.review', { root });
  const { project } = await h.call('project.bind', {
    root,
    name: 'Fixture',
    entryFiles: [],
    reviewToken: r.reviewToken,
  });
  await h.call('snapshot.create', { projectId: project.projectId });
  return project.projectId;
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();
const commits = (root: string) => Number(plainGit(root, ['rev-list', '--count', 'HEAD']).trim());
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const fsck = (root: string) => plainGit(root, ['fsck', '--strict', '--no-dangling', '--no-progress']);
// Every file in the folder (not .git) with its bytes.
const folder = (root: string) =>
  Object.fromEntries(
    Object.entries(digestTree(root))
      .filter(([k]) => !k.startsWith('.git'))
      .map(([k, v]) => [k, v.split(' ')[0]]),
  );

// A project with three versions: V1 (index, style, logo), V2 edits the page
// and adds about.html, V3 deletes style.css.
async function threeVersions(h: Harness) {
  const root = committedRepo({ 'index.html': '<h1>v1</h1>\n' });
  write(root, 'css/style.css', 'body { color: red; }\n');
  write(root, 'img/logo.png', randomBytes(2048));
  const projectId = await connect(h, root);
  const v1 = await h.call('history.list', { projectId }).then((p) => p.entries[0]);
  write(root, 'index.html', '<h1>v2</h1>\n');
  write(root, 'about.html', '<p>about</p>\n');
  await h.call('snapshot.create', { projectId, name: 'V2' });
  rmSync(join(root, 'css/style.css'));
  await h.call('snapshot.create', { projectId, name: 'V3' });
  const v1Id = v1?.snapshot?.snapshotId as string;
  return { root, projectId, v1: v1Id, v1Commit: v1?.commit as string, v1Files: v1 };
}

describe('planning a restore', () => {
  it('says what would be overwritten, added and deleted, and writes nothing', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    const before = digestTree(root);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    expect(digestTree(root)).toEqual(before);
    expect(plan).toMatchObject({
      target: { snapshotId: v1, seq: 1 },
      summary: { overwrite: 1, add: 1, delete: 1 },
      protection: { needed: true, unsavedChanges: 1 },
      settings: { action: 'unchanged', reason: null },
      collisions: { count: 0 },
      blocked: null,
      noop: false,
    });
    expect(plan.changes).toEqual([
      { path: 'about.html', change: 'delete' },
      { path: 'css/style.css', change: 'add' },
      { path: 'index.html', change: 'overwrite' },
    ]);
  });
});

describe('applying a restore', () => {
  it('protects unsaved changes, restores the bytes, and only adds to history', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    plainGit(root, ['branch', 'keep-me']);
    plainGit(root, ['tag', 'v-tag']);
    const refs = () =>
      plainGit(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/heads/keep-me']);
    const otherRefs = refs();
    const v1Bytes = plainGit(root, ['show', `${head(root)}~2:index.html`]);
    write(root, 'index.html', '<h1>unsaved work</h1>\n');
    write(root, 'notes.md', 'new and unsaved\n');
    const tip = head(root);
    const count = commits(root);

    const plan = await h.call('restore.plan', { projectId, target: v1 });
    const result = await h.call('restore.apply', { projectId, planId: plan.planId });

    // History: P (the unsaved work) then R (the content of V1), on top.
    expect(commits(root)).toBe(count + 2);
    expect(plainGit(root, ['rev-parse', 'HEAD~2']).trim()).toBe(tip);
    expect(result.protection?.commit).toBe(plainGit(root, ['rev-parse', 'HEAD~1']).trim());
    expect(result.restored.commit).toBe(head(root));
    expect(plainGit(root, ['show', 'HEAD~1:index.html'])).toBe('<h1>unsaved work</h1>\n');
    expect(plainGit(root, ['show', 'HEAD~1:notes.md'])).toBe('new and unsaved\n');
    // The folder is V1, byte for byte; the restore records V1's tree.
    expect(read(root, 'index.html')).toBe(v1Bytes);
    expect(read(root, 'css/style.css')).toBe('body { color: red; }\n');
    expect(existsSync(join(root, 'about.html'))).toBe(false);
    expect(existsSync(join(root, 'notes.md'))).toBe(false);
    expect(plainGit(root, ['rev-parse', 'HEAD^{tree}']).trim()).toBe(
      plainGit(root, ['rev-parse', `${tip}~2^{tree}`]).trim(),
    );
    // The user's Git agrees, and nothing else changed.
    expect(gitStatus(root)).toBe('');
    fsck(root);
    expect(refs()).toBe(otherRefs);

    const history = await h.call('history.list', { projectId });
    expect(history.entries.slice(0, 2).map((e) => [e.snapshot?.kind, e.snapshot?.restoreOf ?? null, e.seq])).toEqual([
      ['restore', v1, 5],
      ['pre-restore', null, 4],
    ]);
    const op = await h.call('operation.status', { operationId: result.operationId });
    expect(op).toMatchObject({
      kind: 'restore',
      state: 'completed',
      restored: result.restored,
      protection: result.protection,
    });
    expect((await h.call('project.status', { projectId })).changes?.total).toBe(0);
  });

  it('needs no protection version when the folder equals the newest version', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const count = commits(root);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    expect(plan.protection).toEqual({ needed: false, unsavedChanges: 0 });
    const result = await h.call('restore.apply', { projectId, planId: plan.planId });
    expect(result.protection).toBeNull();
    expect(commits(root)).toBe(count + 1);
    expect(gitStatus(root)).toBe('');
  });

  it('answers NO_CHANGES when the folder already matches, adding nothing', async () => {
    const h = await harness();
    const { root, projectId } = await threeVersions(h);
    const newest = (await h.call('history.list', { projectId })).entries[0]?.commit as string;
    const plan = await h.call('restore.plan', { projectId, target: newest });
    expect(plan).toMatchObject({ noop: true, summary: { overwrite: 0, add: 0, delete: 0 } });
    const count = commits(root);
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err.code).toBe('NO_CHANGES');
    expect(commits(root)).toBe(count);
  });
});

describe('refusing a restore', () => {
  it('refuses a plan the folder or history no longer matches, writing nothing', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const count = commits(root);

    const plan = await h.call('restore.plan', { projectId, target: v1 });
    write(root, 'about.html', '<p>edited after the plan</p>\n');
    const before = folder(root);
    const stale = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(stale).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'changed' } });
    expect(folder(root)).toEqual(before);
    expect(commits(root)).toBe(count);
    // A plan is used once.
    const again = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(again).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'used' } });

    const next = await h.call('restore.plan', { projectId, target: v1 });
    plainGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'meanwhile']);
    const moved = await refusal(h.call('restore.apply', { projectId, planId: next.planId }));
    expect(moved).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'history-changed' } });
    expect(folder(root)).toEqual(before);
    expect(commits(root)).toBe(count + 1);
  });

  it('refuses expired plans, unknown plans and plans of another project', async () => {
    const h = await harness({ planTtlMs: 0 });
    const a = await threeVersions(h);
    const b = await threeVersions(h);
    const plan = await h.call('restore.plan', { projectId: a.projectId, target: a.v1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await refusal(h.call('restore.apply', { projectId: a.projectId, planId: plan.planId }))).toMatchObject({
      code: 'PLAN_STALE',
      details: { reason: 'expired' },
    });
    expect(await refusal(h.call('restore.apply', { projectId: b.projectId, planId: plan.planId }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'plan-of-another-project' },
    });
    expect(await refusal(h.call('restore.apply', { projectId: a.projectId, planId: randomUUID() }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'unknown-plan' },
    });
    // A plan id is never authorization, and nothing self-asserted counts.
    expect(
      await refusal(h.call('restore.apply', { projectId: a.projectId, planId: plan.planId, confirmed: true })),
    ).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('never overwrites what no version holds: files in the way block the restore', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n', 'tmp/cache.txt': 'tracked once\n', assets: 'a file once\n' });
    const projectId = await connect(h, root);
    const v1 = (await h.call('history.list', { projectId })).entries[0]?.commit as string;
    rmSync(join(root, 'tmp'), { recursive: true });
    rmSync(join(root, 'assets'));
    write(root, '.gitignore', 'tmp/\nassets/\n');
    await h.call('snapshot.create', { projectId });
    // Ignored, so in no version: a cache file and a folder of exports.
    write(root, 'tmp/cache.txt', 'precious, ignored\n');
    write(root, 'assets/export.png', randomBytes(64));
    const before = folder(root);

    const plan = await h.call('restore.plan', { projectId, target: v1 });
    expect(plan.blocked).toBe('UNTRACKED_FILES');
    expect(plan.collisions.entries).toEqual([
      { path: 'assets', reason: 'folder' },
      { path: 'tmp/cache.txt', reason: 'unsaved-file' },
    ]);
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err.code).toBe('UNTRACKED_FILES');
    expect(folder(root)).toEqual(before);
  });

  it.skipIf(onWindows)('refuses a version holding what a folder cannot hold, such as a symlink', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n' });
    symlinkSync('index.html', join(root, 'alias.html'));
    plainGit(root, ['add', 'alias.html']);
    plainGit(root, ['commit', '--quiet', '-m', 'an engineer adds a symlink']);
    const linked = head(root);
    plainGit(root, ['rm', '--quiet', 'alias.html']);
    plainGit(root, ['commit', '--quiet', '-m', 'and removes it']);
    const projectId = await connect(h, root);
    const err = await refusal(h.call('restore.plan', { projectId, target: linked }));
    expect(err).toMatchObject({ code: 'UNSUPPORTED_ENTRY', details: { reason: 'version-not-restorable' } });
    expect(err.details['entries']).toEqual([{ path: 'alias.html', kind: 'symlink' }]);
  });

  it('refuses while another Git holds the index, changing nothing', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    write(root, 'index.html', 'unsaved\n');
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const before = folder(root);
    const count = commits(root);
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err.code).toBe('LOCKED');
    expect(folder(root)).toEqual(before);
    expect(commits(root)).toBe(count);
  });
});

describe('a deleted settings file', () => {
  it('blocks restoring until it is put back from the newest version, never over an existing file', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const settings = read(root, PROJECT_CONFIG_FILE);
    rmSync(join(root, PROJECT_CONFIG_FILE));
    expect((await h.call('project.status', { projectId })).folder).toBe('config-missing');
    expect(await refusal(h.call('restore.plan', { projectId, target: v1 }))).toMatchObject({
      code: 'CONFIG_INVALID',
      details: { reason: 'missing' },
    });
    const back = await h.call('project.restoreSettings', { projectId });
    expect(back.from).toBe(head(root));
    expect(read(root, PROJECT_CONFIG_FILE)).toBe(settings);
    expect(await h.call('project.status', { projectId })).toMatchObject({ folder: 'available', changes: { total: 0 } });
    expect(gitStatus(root)).toBe('');

    write(root, PROJECT_CONFIG_FILE, '{ broken');
    expect(await refusal(h.call('project.restoreSettings', { projectId }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'settings-present' },
    });
    expect(read(root, PROJECT_CONFIG_FILE)).toBe('{ broken');
  });
});

describe('what a restore writes', () => {
  it('brings back binary assets byte for byte, large ones streamed', async () => {
    const h = await harness();
    const logo = randomBytes(2048);
    const hero = randomBytes(3 * 1024 * 1024 + 17);
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'img/logo.png', logo);
    write(root, 'img/hero.jpg', hero);
    const projectId = await connect(h, root);
    const v1 = (await h.call('history.list', { projectId })).entries[0]?.commit as string;
    write(root, 'img/logo.png', randomBytes(2048));
    write(root, 'img/hero.jpg', randomBytes(1024));
    await h.call('snapshot.create', { projectId });

    const plan = await h.call('restore.plan', { projectId, target: v1 });
    expect(plan.space.requiredBytes).toBe(logo.length + hero.length);
    await h.call('restore.apply', { projectId, planId: plan.planId });
    expect(readFileSync(join(root, 'img/logo.png')).equals(logo)).toBe(true);
    expect(readFileSync(join(root, 'img/hero.jpg')).equals(hero)).toBe(true);
    expect(gitStatus(root)).toBe('');
    fsck(root);
  });

  it('keeps the current settings when the version has none that names this project', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'engineer v0\n' });
    const external = head(root);
    const projectId = await connect(h, root);
    const settings = read(root, PROJECT_CONFIG_FILE);
    write(root, 'index.html', 'v1\n');
    await h.call('snapshot.create', { projectId });

    const plan = await h.call('restore.plan', { projectId, target: external });
    expect(plan.settings).toEqual({ action: 'kept', reason: 'missing' });
    expect(plan.changes).toEqual([{ path: 'index.html', change: 'overwrite' }]);
    await h.call('restore.apply', { projectId, planId: plan.planId });
    expect(read(root, 'index.html')).toBe('engineer v0\n');
    expect(read(root, PROJECT_CONFIG_FILE)).toBe(settings);
    expect(plainGit(root, ['show', `HEAD:${PROJECT_CONFIG_FILE}`])).toBe(settings);
    expect(gitStatus(root)).toBe('');
    expect(await h.call('project.status', { projectId })).toMatchObject({ folder: 'available', changes: { total: 0 } });
  });

  it.skipIf(onWindows)('brings back modes and folders, replacing a file that took a folder’s place', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'run.sh', '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    write(root, 'pages/deep/a.html', 'a\n');
    const projectId = await connect(h, root);
    const v1 = (await h.call('history.list', { projectId })).entries[0]?.commit as string;
    chmodSync(join(root, 'run.sh'), 0o644);
    rmSync(join(root, 'pages'), { recursive: true });
    write(root, 'pages', 'now a file\n');
    await h.call('snapshot.create', { projectId });

    const plan = await h.call('restore.plan', { projectId, target: v1 });
    expect(plan.collisions.count).toBe(0);
    await h.call('restore.apply', { projectId, planId: plan.planId });
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(read(root, 'pages/deep/a.html')).toBe('a\n');
    expect(gitStatus(root)).toBe('');

    // And back: the folder goes, the file returns.
    const newest = (await h.call('history.list', { projectId })).entries[1]?.commit as string;
    const back = await h.call('restore.plan', { projectId, target: newest });
    await h.call('restore.apply', { projectId, planId: back.planId });
    expect(read(root, 'pages')).toBe('now a file\n');
    expect(gitStatus(root)).toBe('');
  });
});

function operationIn(h: Harness, state: string): string {
  const rec = h.store.listOperations({ kinds: ['restore'], states: [state as never] })[0];
  if (!rec) throw new Error(`no restore in ${state}`);
  return rec.operationId;
}

describe('changes during a restore', () => {
  it('stops before the first write when a file changed after the check, keeping the protection', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    write(root, 'notes.md', 'unsaved\n');
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    // Deletions go first: about.html is the first file the restore touches.
    h.at.set('restore:staged', () => write(root, 'about.html', 'written by an agent meanwhile\n'));
    const count = commits(root);
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'external-change' } });
    expect(read(root, 'about.html')).toBe('written by an agent meanwhile\n');
    expect(read(root, 'index.html')).toBe('<h1>v2</h1>\n');
    expect(read(root, 'notes.md')).toBe('unsaved\n');
    expect(commits(root)).toBe(count + 1);
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Before restore/);
    const [op] = h.store.listOperations({ kinds: ['restore'] });
    expect(op).toMatchObject({ state: 'failed' });
    expect(await h.call('project.status', { projectId })).toMatchObject({ recoveryRequired: false });
  });

  it('stops part-way when a file changes while writing; recovery finishes around it', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    // Deletes go first (about.html), then css/style.css, then index.html. An
    // editor writes the style sheet just before the restore would.
    h.at.set('restore:file', (d) => {
      if (d?.index === 1) write(root, 'css/style.css', 'an editor saved this\n');
    });
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err).toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'external-change' } });
    h.at.clear();
    expect(read(root, 'css/style.css')).toBe('an editor saved this\n');
    expect(read(root, 'index.html')).toBe('<h1>v2</h1>\n');
    expect(existsSync(join(root, 'about.html'))).toBe(false);

    const status = await h.call('project.status', { projectId });
    expect(status.recoveryRequired).toBe(true);
    expect((await refusal(h.call('snapshot.create', { projectId }))).code).toBe('RECOVERY_REQUIRED');
    const report = await h.call('recovery.inspect', { projectId });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      kind: 'restore',
      reason: 'external-change',
      automatic: false,
      strategies: ['finish', 'rollback'],
      files: { total: 3, done: 1, pending: 1, conflicts: { count: 1, sample: ['css/style.css'] } },
    });
    const operationId = report.items[0]?.operationId as string;
    const fix = await h.call('recovery.plan', { projectId, operationId, strategy: 'finish' });
    expect(fix).toMatchObject({ write: 1, delete: 0, unchanged: 1, conflicts: { count: 1 }, records: true });
    const done = await h.call('recovery.apply', { projectId, planId: fix.planId });
    expect(done.operation).toMatchObject({ state: 'completed', conflicts: { count: 1, sample: ['css/style.css'] } });
    // The restore is recorded; the editor's file is kept and shows as unsaved.
    expect(read(root, 'index.html')).toBe('<h1>v1</h1>\n');
    expect(read(root, 'css/style.css')).toBe('an editor saved this\n');
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Restored version/);
    expect(plainGit(root, ['status', '--porcelain'])).toBe(' M css/style.css\n');
    expect((await h.call('project.status', { projectId })).recoveryRequired).toBe(false);
    fsck(root);
  });

  it('rolls back what it wrote when asked, leaving the changed file alone', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const before = folder(root);
    const count = commits(root);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    h.at.set('restore:file', (d) => {
      if (d?.index === 2) write(root, 'index.html', 'an editor saved this\n');
    });
    await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    h.at.clear();
    const [item] = (await h.call('recovery.inspect', { projectId })).items;
    const back = await h.call('recovery.plan', {
      projectId,
      operationId: item?.operationId as string,
      strategy: 'rollback',
    });
    expect(back).toMatchObject({ write: 1, delete: 1, records: false });
    const done = await h.call('recovery.apply', { projectId, planId: back.planId });
    expect(done.operation).toMatchObject({ state: 'rolled-back' });
    expect(folder(root)).toEqual({ ...before, 'index.html': folder(root)['index.html'] });
    expect(read(root, 'index.html')).toBe('an editor saved this\n');
    expect(commits(root)).toBe(count);
    expect(plainGit(root, ['status', '--porcelain'])).toBe(' M index.html\n');
  });

  it('records the restore on top of a commit another program made meanwhile', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    h.at.set('restore:verified', () => {
      plainGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'an engineer commits meanwhile']);
    });
    const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    expect(err).toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'history-changed' } });
    h.at.clear();
    const theirs = head(root);
    const [item] = (await h.call('recovery.inspect', { projectId })).items;
    expect(item).toMatchObject({ reason: 'history-changed', files: { done: 3, pending: 0 } });
    const fix = await h.call('recovery.plan', {
      projectId,
      operationId: item?.operationId as string,
      strategy: 'finish',
    });
    await h.call('recovery.apply', { projectId, planId: fix.planId });
    expect(plainGit(root, ['rev-parse', 'HEAD~1']).trim()).toBe(theirs);
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Restored version/);
    expect(gitStatus(root)).toBe('');
  });
});

describe('agent access and cancelling', () => {
  it('needs agent access on the tool channel, checked again before any file is written', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    expect((await refusal(h.call('restore.plan', { projectId, target: v1 }, 'cli'))).code).toBe(
      'AGENT_ACCESS_DISABLED',
    );
    await h.call('agentAccess.set', { enabled: true });
    write(root, 'index.html', 'unsaved\n');
    const before = folder(root);
    for (const point of ['restore:preflight', 'restore:staged']) {
      const plan = await h.call('restore.plan', { projectId, target: v1 }, 'mcp');
      h.at.set(point, () => void h.store.setAgentAccess(false, new Date().toISOString()));
      const err = await refusal(h.call('restore.apply', { projectId, planId: plan.planId }, 'mcp'));
      expect(err.code, point).toBe('AGENT_ACCESS_DISABLED');
      expect(folder(root), point).toEqual(before);
      h.at.clear();
      h.store.setAgentAccess(true, new Date().toISOString());
    }
  });

  it('finishes a restore that is already writing when access is turned off', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    await h.call('agentAccess.set', { enabled: true });
    const plan = await h.call('restore.plan', { projectId, target: v1 }, 'cli');
    h.at.set('restore:file', () => void h.store.setAgentAccess(false, new Date().toISOString()));
    const result = await h.call('restore.apply', { projectId, planId: plan.planId }, 'cli');
    expect(result.restored.commit).toBe(head(root));
    expect(gitStatus(root)).toBe('');
  });

  it('cancels before the first file is written, and only then', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const before = folder(root);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    h.at.set('restore:preflight', async () => {
      const operationId = operationIn(h, 'preflight');
      expect(await h.call('operation.cancel', { operationId })).toMatchObject({ outcome: 'cancelling' });
    });
    expect((await refusal(h.call('restore.apply', { projectId, planId: plan.planId }))).code).toBe('CANCELLED');
    expect(folder(root)).toEqual(before);
    expect(h.store.listOperations({ kinds: ['restore'] })[0]?.state).toBe('cancelled');
    h.at.clear();

    const next = await h.call('restore.plan', { projectId, target: v1 });
    let outcome = '';
    h.at.set('restore:file', async () => {
      const operationId = operationIn(h, 'applying');
      outcome = (await h.call('operation.cancel', { operationId })).outcome;
    });
    await h.call('restore.apply', { projectId, planId: next.planId });
    expect(outcome).toBe('too-late');
    expect(gitStatus(root)).toBe('');
  });

  it('shows an agent’s restore to the app until the user dismisses it', async () => {
    const h = await harness();
    const { projectId, v1 } = await threeVersions(h);
    await h.call('agentAccess.set', { enabled: true });
    const plan = await h.call('restore.plan', { projectId, target: v1 }, 'mcp');
    const result = await h.call('restore.apply', { projectId, planId: plan.planId }, 'mcp');
    const list = await h.call('operation.list', {});
    expect(list.notices.map((n) => [n.operationId, n.origin, n.state])).toEqual([
      [result.operationId, 'mcp', 'completed'],
    ]);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        name: 'operation.settled',
        operation: 'restore.apply',
        origin: 'mcp',
        outcome: 'completed',
      }),
    );
    await h.call('operation.dismiss', { operationId: result.operationId });
    expect((await h.call('operation.list', {})).notices).toEqual([]);
    // The tool channel can't dismiss or list for the app.
    expect((await refusal(h.call('operation.list', {}, 'cli'))).code).toBe('UNKNOWN_OPERATION');
    // History says who restored.
    const [restored] = (await h.call('history.list', { projectId })).entries;
    expect(restored?.snapshot).toMatchObject({ kind: 'restore', origin: 'mcp', restoreOf: v1 });
  });
});

describe('one change at a time', () => {
  it('queues a save behind a restore, and a queued save can be cancelled before it starts', async () => {
    const h = await harness();
    const { root, projectId, v1 } = await threeVersions(h);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    let release = () => undefined as void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => undefined as void;
    const inRestore = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.at.set('restore:protected', async () => {
      entered();
      await paused;
    });
    const restoring = h.call('restore.apply', { projectId, planId: plan.planId });
    await inRestore;
    expect((await h.call('project.status', { projectId })).activeOperation).toMatchObject({ activity: 'restoring' });

    const saving = h.call('snapshot.create', { projectId });
    const queued = h.store.listOperations({ kinds: ['save'], states: ['confirmed'] })[0];
    expect(queued).toBeDefined();
    expect(await h.call('operation.cancel', { operationId: queued?.operationId as never })).toMatchObject({
      outcome: 'cancelling',
    });
    release();
    await restoring;
    expect((await refusal(saving)).code).toBe('CANCELLED');
    expect(await h.call('operation.status', { operationId: queued?.operationId as never })).toMatchObject({
      state: 'cancelled',
      error: { code: 'CANCELLED' },
    });
    expect(gitStatus(root)).toBe('');
  });
});

describe('what the review found', () => {
  it('restores a case-only rename, also on a case-insensitive filesystem', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n', 'Logo.png': 'logo bytes' });
    const capital = head(root);
    plainGit(root, ['mv', 'Logo.png', 'logo.png']);
    plainGit(root, ['commit', '--quiet', '-m', 'lowercase the logo']);
    const projectId = await connect(h, root);
    const plan = await h.call('restore.plan', { projectId, target: capital });
    expect(plan.changes).toEqual([
      { path: 'Logo.png', change: 'add' },
      { path: 'logo.png', change: 'delete' },
    ]);
    expect(plan.collisions.count).toBe(0);
    await h.call('restore.apply', { projectId, planId: plan.planId });
    const names = plainGit(root, ['ls-files']).split('\n').filter(Boolean);
    expect(names).toContain('Logo.png');
    expect(names).not.toContain('logo.png');
    expect(readFileSync(join(root, 'Logo.png'), 'utf8')).toBe('logo bytes');
    expect(gitStatus(root)).toBe('');
    expect((await h.call('project.status', { projectId })).recoveryRequired).toBe(false);
  });

  it('rolls back a file that took a folder’s place, folder files and all', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n', a: 'a file\n' });
    const projectId = await connect(h, root);
    const v1 = (await h.call('history.list', { projectId })).entries[0]?.commit as string;
    rmSync(join(root, 'a'));
    write(root, 'a/b.txt', 'in a folder\n');
    await h.call('snapshot.create', { projectId });
    const before = folder(root);
    const plan = await h.call('restore.plan', { projectId, target: v1 });
    h.at.set('restore:verified', () => {
      plainGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'meanwhile']);
    });
    await refusal(h.call('restore.apply', { projectId, planId: plan.planId }));
    h.at.clear();
    expect(read(root, 'a')).toBe('a file\n');
    const [item] = (await h.call('recovery.inspect', { projectId })).items;
    expect(item?.files).toMatchObject({ done: 2, pending: 0, conflicts: { count: 0 } });
    const back = await h.call('recovery.plan', {
      projectId,
      operationId: item?.operationId as never,
      strategy: 'rollback',
    });
    const done = await h.call('recovery.apply', { projectId, planId: back.planId });
    expect(done).toMatchObject({ operation: { state: 'rolled-back' }, conflicts: { count: 0 } });
    expect(folder(root)).toEqual(before);
  });

  it('never switches the index of a branch HEAD has left during a save', async () => {
    const h = await harness();
    const root = committedRepo({ 'index.html': 'v1\n' });
    const projectId = await connect(h, root);
    const main = plainGit(root, ['rev-parse', 'main']).trim();
    write(root, 'index.html', 'v2\n');
    h.at.set('save:publishing', () => {
      plainGit(root, ['switch', '--quiet', '-c', 'feature']);
    });
    const err = await refusal(h.call('snapshot.create', { projectId }));
    expect(err).toMatchObject({ code: 'HISTORY_CHANGED', details: { reason: 'branch-changed' } });
    expect(plainGit(root, ['rev-parse', 'main']).trim()).toBe(main);
    expect(plainGit(root, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature');
    expect(plainGit(root, ['diff', '--cached', '--name-only'])).toBe('');
    expect(existsSync(join(root, '.git', 'index.lock'))).toBe(false);
  });
});
