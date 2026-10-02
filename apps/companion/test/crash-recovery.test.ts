// Crash recovery (M1 plan §9.3.1, §9.4, §13.1) on a real Engine process,
// real Git and SQLite. A development Engine started with
// DRAFT_TIDE_TEST_CRASH_AT kills itself (SIGKILL) at that point; the next
// Engine recovers at start, or leaves the decision to the user (GUI or CLI).
// The window that matters most is a publish whose ref moved but whose index
// wasn't switched: there, another Git's plain `git commit` must be blocked by
// the lock, and after recovery `git status` is clean.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DtError, readCommitMetadata } from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  committedRepo,
  gitStatus,
  plainGit,
  plainGitResult,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, cleanupDataDirs, connectTo, stopEngine, tempDataDir } from './helpers.ts';

afterAll(async () => {
  await cleanupDataDirs();
  cleanupTempDirs();
});

async function refusal(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const lockOf = (root: string) => {
  const file = join(root, '.git', 'index.lock');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};
const preparedIndexes = (root: string) => readdirSync(join(root, '.git')).filter((f) => f.startsWith('index.dt-'));
// `git log --format=%B` adds a line break of its own.
const tipMetadata = (root: string) =>
  readCommitMetadata(plainGit(root, ['log', '-1', '--format=%B']).replace(/\n$/, ''));

// An Engine that dies at `point`, and a fresh one afterwards.
async function crashing(dataDir: string, point: string): Promise<EngineConnection> {
  await stopEngine(dataDir);
  return connectTo(dataDir, 'desktop', 5_000, { DRAFT_TIDE_TEST_CRASH_AT: point });
}

async function fresh(dataDir: string): Promise<EngineConnection> {
  await stopEngine(dataDir);
  return connectTo(dataDir, 'desktop', 5_000);
}

async function crashed(p: Promise<unknown>): Promise<void> {
  const err = await refusal(p);
  expect(err.code).toBe('ENGINE_UNAVAILABLE');
}

// A connected project with V1 and V2; V1 has index.html, style.css and a logo.
async function project(dataDir: string) {
  const root = committedRepo({ 'index.html': '<h1>v1</h1>\n' });
  write(root, 'style.css', 'body { color: red; }\n');
  write(root, 'logo.png', randomBytes(1024));
  const conn = await fresh(dataDir);
  const r = await conn.call('project.review', { root });
  const { project } = await conn.call('project.bind', {
    root,
    name: 'Crash',
    entryFiles: [],
    reviewToken: r.reviewToken,
  });
  const projectId = project.projectId;
  const v1 = await conn.call('snapshot.create', { projectId });
  write(root, 'index.html', '<h1>v2</h1>\n');
  write(root, 'style.css', 'body { color: blue; }\n');
  write(root, 'about.html', '<p>about</p>\n');
  await conn.call('snapshot.create', { projectId });
  conn.close();
  return { root, projectId, v1: v1.snapshotId };
}

function cli(dataDir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--data-dir', dataDir, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    timeout: 30_000,
  });
  return JSON.parse(r.stdout) as { ok: boolean; data: Record<string, unknown>; error: { code: string } | null };
}

describe('a save cut short', () => {
  it('between moving the ref and switching the index: Git is blocked, the next Engine finishes it', async () => {
    const dataDir = tempDataDir();
    const { root, projectId } = await project(dataDir);
    write(root, 'index.html', '<h1>v3</h1>\n');
    const before = head(root);
    const conn = await crashing(dataDir, 'publish:after-ref');
    await crashed(conn.call('snapshot.create', { projectId, name: 'V3' }));

    // The version is in history; the old index is locked away from any Git.
    const after = head(root);
    expect(after).not.toBe(before);
    const meta = tipMetadata(root);
    if (meta.status !== 'snapshot') throw new Error('expected a version');
    expect(lockOf(root)).toBe(`draft-tide ${meta.metadata.operationId}\n`);
    write(root, 'engineer.txt', 'x\n');
    plainGitResult(root, ['add', 'engineer.txt']);
    const commit = plainGitResult(root, ['commit', '-m', 'would commit the old tree']);
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toMatch(/index\.lock/);
    rmSync(join(root, 'engineer.txt'));

    // The next Engine completes the switch at start.
    const next = await fresh(dataDir);
    expect(lockOf(root)).toBeNull();
    expect(preparedIndexes(root)).toEqual([]);
    expect(head(root)).toBe(after);
    expect(gitStatus(root)).toBe('');
    const status = await next.call('project.status', { projectId });
    expect(status).toMatchObject({ recoveryRequired: false, changes: { total: 0 } });
    const history = await next.call('history.list', { projectId });
    expect(history.entries.filter((e) => e.snapshot?.name === 'V3')).toHaveLength(1);
    next.close();
  });

  it('after recording the publish but before the lock: nothing changed, and saving works', async () => {
    const dataDir = tempDataDir();
    const { root, projectId } = await project(dataDir);
    write(root, 'index.html', '<h1>v3</h1>\n');
    const before = head(root);
    const conn = await crashing(dataDir, 'save:publishing');
    await crashed(conn.call('snapshot.create', { projectId }));
    expect(head(root)).toBe(before);

    const next = await fresh(dataDir);
    expect(lockOf(root)).toBeNull();
    expect(preparedIndexes(root)).toEqual([]);
    expect(readdirSync(join(dataDir, 'projects', projectId, 'operations'))).toEqual([]);
    expect(await next.call('project.status', { projectId })).toMatchObject({ recoveryRequired: false });
    const saved = await next.call('snapshot.create', { projectId });
    expect(saved.parent).toBe(before);
    expect(gitStatus(root)).toBe('');
    next.close();
  });

  it('after the switch but before recording it: the journal is completed, the index left as Git has it', async () => {
    const dataDir = tempDataDir();
    const { root, projectId } = await project(dataDir);
    write(root, 'index.html', '<h1>v3</h1>\n');
    const conn = await crashing(dataDir, 'save:published');
    await crashed(conn.call('snapshot.create', { projectId }));
    // An engineer stages a file before Draft Tide starts again.
    write(root, 'staged.txt', 'staged by hand\n');
    plainGit(root, ['add', 'staged.txt']);
    const next = await fresh(dataDir);
    expect(plainGit(root, ['diff', '--cached', '--name-only'])).toBe('staged.txt\n');
    expect(await next.call('project.status', { projectId })).toMatchObject({ recoveryRequired: false });
    const saves = (await next.call('operation.list', {})).attention;
    expect(saves).toEqual([]);
    next.close();
  });

  it('finishes a lock an earlier Draft Tide left without a journal, and asks about one nothing explains', async () => {
    const dataDir = tempDataDir();
    const { root, projectId } = await project(dataDir);
    const meta = tipMetadata(root);
    if (meta.status !== 'snapshot') throw new Error('expected a version');
    writeFileSync(join(root, '.git', 'index.lock'), `draft-tide ${meta.metadata.operationId}\n`);
    const next = await fresh(dataDir);
    expect(lockOf(root)).toBeNull();
    expect(gitStatus(root)).toBe('');

    const stranger = 'f3a1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b';
    writeFileSync(join(root, '.git', 'index.lock'), `draft-tide ${stranger}\n`);
    const report = await next.call('recovery.inspect', { projectId });
    expect(report).toMatchObject({
      lock: 'draft-tide',
      items: [
        { operationId: stranger, kind: 'lock', reason: 'unknown-lock', automatic: false, strategies: ['rollback'] },
      ],
    });
    expect((await refusal(next.call('snapshot.create', { projectId }))).code).toBe('RECOVERY_REQUIRED');
    const plan = await next.call('recovery.plan', { projectId, operationId: stranger, strategy: 'rollback' });
    expect(await next.call('recovery.apply', { projectId, planId: plan.planId })).toMatchObject({ operation: null });
    expect(lockOf(root)).toBeNull();
    // Another Git's lock is never touched.
    writeFileSync(join(root, '.git', 'index.lock'), '');
    expect((await next.call('recovery.inspect', { projectId })).items).toEqual([]);
    rmSync(join(root, '.git', 'index.lock'));
    next.close();
  });
});

describe('a restore cut short', () => {
  it('while publishing the pre-restore version: the version is completed, no file was touched', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    const conn = await crashing(dataDir, 'publish:after-ref');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));

    const next = await fresh(dataDir);
    expect(lockOf(root)).toBeNull();
    expect(read(root, 'index.html')).toBe('<h1>unsaved</h1>\n');
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Before restore/);
    expect(gitStatus(root)).toBe('');
    const [op] = (await next.call('operation.list', {})).attention;
    expect(op).toBeUndefined();
    const status = await next.call('project.status', { projectId });
    expect(status).toMatchObject({ recoveryRequired: false, changes: { total: 0 } });
    next.close();
  });

  it('after protecting, before any file: nothing to recover', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    const conn = await crashing(dataDir, 'restore:protected');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));
    const next = await fresh(dataDir);
    expect(read(root, 'index.html')).toBe('<h1>unsaved</h1>\n');
    expect(await next.call('project.status', { projectId })).toMatchObject({ recoveryRequired: false });
    expect(gitStatus(root)).toBe('');
    next.close();
  });

  it('part-way through the files: the user finishes it (CLI), bytes and Git end up right', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    const conn = await crashing(dataDir, 'restore:file:2');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));

    const next = await fresh(dataDir);
    expect(await next.call('project.status', { projectId })).toMatchObject({ recoveryRequired: true });
    const [item] = (await next.call('recovery.inspect', { projectId })).items;
    expect(item).toMatchObject({
      kind: 'restore',
      reason: 'interrupted',
      automatic: false,
      files: { total: 3, done: 2, pending: 1 },
    });
    expect((await next.call('operation.list', {})).attention.map((o) => o.operationId)).toEqual([item?.operationId]);
    next.close();

    await connectTo(dataDir, 'desktop').then((d) => d.call('agentAccess.set', { enabled: true }).then(() => d.close()));
    const planned = cli(dataDir, '--project', projectId, 'recover', 'plan', '--strategy', 'finish');
    expect(planned).toMatchObject({ ok: true, data: { strategy: 'finish', write: 1, unchanged: 2, records: true } });
    const applied = cli(dataDir, '--project', projectId, 'recover', 'apply', String(planned.data['planId']));
    expect(applied).toMatchObject({ ok: true, data: { operation: { state: 'completed' } } });
    expect(read(root, 'index.html')).toBe('<h1>v1</h1>\n');
    expect(read(root, 'style.css')).toBe('body { color: red; }\n');
    expect(existsSync(join(root, 'about.html'))).toBe(false);
    expect(gitStatus(root)).toBe('');
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Restored version/);
  });

  it('part-way through the files: the user rolls it back to the protected content', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    const conn = await crashing(dataDir, 'restore:file:2');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));

    const next = await fresh(dataDir);
    const [item] = (await next.call('recovery.inspect', { projectId })).items;
    const back = await next.call('recovery.plan', {
      projectId,
      operationId: item?.operationId as never,
      strategy: 'rollback',
    });
    const done = await next.call('recovery.apply', { projectId, planId: back.planId });
    expect(done.operation).toMatchObject({ state: 'rolled-back' });
    expect(read(root, 'index.html')).toBe('<h1>unsaved</h1>\n');
    expect(read(root, 'about.html')).toBe('<p>about</p>\n');
    expect(read(root, 'style.css')).toBe('body { color: blue; }\n');
    // The protection version holds exactly this, and nothing else was recorded.
    expect(plainGit(root, ['log', '-1', '--format=%s'])).toMatch(/Before restore/);
    expect(gitStatus(root)).toBe('');
    next.close();
  });

  it('with every file written but the version not recorded: finishing records it once', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    const conn = await crashing(dataDir, 'restore:publishing');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));

    const next = await fresh(dataDir);
    const [item] = (await next.call('recovery.inspect', { projectId })).items;
    expect(item).toMatchObject({ reason: 'not-recorded', files: { done: 3, pending: 0 } });
    const fix = await next.call('recovery.plan', {
      projectId,
      operationId: item?.operationId as never,
      strategy: 'finish',
    });
    expect(fix).toMatchObject({ write: 0, delete: 0, unchanged: 3, records: true });
    await next.call('recovery.apply', { projectId, planId: fix.planId });
    const history = await next.call('history.list', { projectId });
    expect(history.entries.filter((e) => e.snapshot?.kind === 'restore')).toHaveLength(1);
    expect(gitStatus(root)).toBe('');
    next.close();
  });

  it('between moving the ref and switching the index of the restore version: finished at start', async () => {
    const dataDir = tempDataDir();
    const { root, projectId, v1 } = await project(dataDir);
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    // The pre-restore version publishes first; the second publish is the restore.
    const conn = await crashing(dataDir, 'publish:after-ref#2');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));
    expect(lockOf(root)).toMatch(/^draft-tide /);
    expect(plainGitResult(root, ['commit', '--allow-empty', '-m', 'blocked']).status).not.toBe(0);

    const next = await fresh(dataDir);
    expect(lockOf(root)).toBeNull();
    expect(gitStatus(root)).toBe('');
    expect(read(root, 'index.html')).toBe('<h1>v1</h1>\n');
    const [restored, protection] = (await next.call('history.list', { projectId })).entries;
    expect(restored?.snapshot).toMatchObject({ kind: 'restore', restoreOf: v1 });
    expect(protection?.snapshot).toMatchObject({ kind: 'pre-restore' });
    expect(await next.call('project.status', { projectId })).toMatchObject({ recoveryRequired: false });
    next.close();
  });
});

describe('the journal itself', () => {
  it('survives restarts: a stopped restore is still there, with its files, until recovered', async () => {
    const dataDir = tempDataDir();
    const { projectId, v1 } = await project(dataDir);
    const conn = await crashing(dataDir, 'restore:file:1');
    const plan = await conn.call('restore.plan', { projectId, target: v1 });
    await crashed(conn.call('restore.apply', { projectId, planId: plan.planId }));
    for (let i = 0; i < 2; i++) {
      const next = await fresh(dataDir);
      const report = await next.call('recovery.inspect', { projectId: projectId });
      expect(report.items).toHaveLength(1);
      expect(report.items[0]?.files).toMatchObject({ total: 3, done: 1, pending: 2 });
      next.close();
    }
  });
});
