import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  DtError,
  OperationId,
  PlanId,
  ProjectId,
  type OperationJournal,
  type PreviewRecord,
} from '@draft-tide/contracts';
import type { OperationRecord, StoredPlan, StoredPreview } from '@draft-tide/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  STATE_DB_FILE,
  openLocalStore,
  tryAcquireEngineLock,
  type Migration,
} from '../src/index.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dt-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  // Windows releases a killed process's file handles a moment later.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

async function failure(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

describe('openLocalStore', () => {
  it('creates a WAL database at the latest schema with agent access off', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    expect(store.storageSchemaVersion).toBe(MIGRATIONS.at(-1)?.version);
    expect(store.getAgentAccess()).toEqual({ enabled: false, updatedAt: null });
    expect(store.listProjects()).toEqual([]);
    store.close();
    const raw = new Database(join(dataDir, STATE_DB_FILE), { readonly: true });
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
  });

  it('keeps the agent-access switch across reopen', async () => {
    const dataDir = tempDir();
    const a = await openLocalStore({ dataDir });
    const at = new Date().toISOString();
    expect(a.setAgentAccess(true, at)).toEqual({ enabled: true, updatedAt: at });
    a.close();
    const b = await openLocalStore({ dataDir });
    expect(b.getAgentAccess()).toEqual({ enabled: true, updatedAt: at });
    b.close();
  });

  it('reads an unreadable switch value as off', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    store.close();
    const raw = new Database(join(dataDir, STATE_DB_FILE));
    raw.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('agent_access', '{oops', 'x')`).run();
    raw.close();
    const again = await openLocalStore({ dataDir });
    expect(again.getAgentAccess().enabled).toBe(false);
    again.close();
  });

  it('lists bindings in the order they were made', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    store.close();
    const raw = new Database(join(dataDir, STATE_DB_FILE));
    const ins = raw.prepare('INSERT INTO project_bindings (project_id, root, name, bound_at) VALUES (?, ?, ?, ?)');
    const [p1, p2] = [randomUUID(), randomUUID()];
    ins.run(p2, '/b', 'B', '2026-10-01T10:00:01.000Z');
    ins.run(p1, '/a', 'A', '2026-10-01T10:00:00.000Z');
    expect(() => ins.run(randomUUID(), '/a', 'dup', '2026-10-01T10:00:02.000Z')).toThrow(/UNIQUE/);
    raw.close();
    const again = await openLocalStore({ dataDir });
    expect(again.listProjects().map((p) => p.name)).toEqual(['A', 'B']);
    again.close();
  });

  it('binds, finds, relinks and renames projects, one root per project', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    const a = { projectId: ProjectId.parse(randomUUID()), name: 'A', root: '/a', boundAt: new Date().toISOString() };
    store.insertProject(a);
    expect(store.getProject(a.projectId)).toEqual(a);
    expect(store.findProjectByRoot('/a')).toEqual(a);
    expect(store.findProjectByRoot('/elsewhere')).toBeNull();
    expect(store.getProject(ProjectId.parse(randomUUID()))).toBeNull();
    // A second binding of the same root, or of the same project, is refused.
    expect(() => store.insertProject({ ...a, projectId: ProjectId.parse(randomUUID()) })).toThrow(/UNIQUE/);
    expect(() => store.insertProject({ ...a, root: '/b' })).toThrow(/UNIQUE|PRIMARY/);
    store.updateProject(a.projectId, { root: '/moved' });
    store.updateProject(a.projectId, { name: 'Renamed' });
    expect(store.getProject(a.projectId)).toEqual({ ...a, root: '/moved', name: 'Renamed' });
    expect(() => store.updateProject(ProjectId.parse(randomUUID()), { name: 'x' })).toThrow(DtError);
    store.close();
    const again = await openLocalStore({ dataDir });
    expect(again.findProjectByRoot('/moved')?.projectId).toBe(a.projectId);
    again.close();
  });

  it('refuses a database from a newer Draft Tide without writing to it', async () => {
    const dataDir = tempDir();
    const newer: Migration[] = [...MIGRATIONS, { version: 99, name: 'future', up: () => undefined }];
    (await openLocalStore({ dataDir, migrations: newer })).close();
    const file = join(dataDir, STATE_DB_FILE);
    const before = sha(file);
    const err = await failure(openLocalStore({ dataDir }));
    expect(err.code).toBe('PROTOCOL_MISMATCH');
    expect(err.details).toMatchObject({ storageSchemaVersion: 99 });
    expect(sha(file)).toBe(before);
  });

  it('backs up before migrating and rolls a failed migration back', async () => {
    const dataDir = tempDir();
    const first = MIGRATIONS.filter((m) => m.version === 1);
    const v1 = await openLocalStore({ dataDir, migrations: first });
    v1.setAgentAccess(true, new Date().toISOString());
    v1.close();

    const broken: Migration[] = [
      ...first,
      {
        version: 2,
        name: 'half-done',
        up(db) {
          db.exec('CREATE TABLE half (x INTEGER) STRICT');
          throw new Error('boom');
        },
      },
    ];
    await expect(openLocalStore({ dataDir, migrations: broken })).rejects.toThrow();
    const backups = readdirSync(dataDir).filter((f) => f.startsWith(`${STATE_DB_FILE}.backup-v1-`));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dataDir, backups[0] ?? ''), { readonly: true });
    expect(backup.prepare(`SELECT value FROM settings WHERE key = 'agent_access'`).get()).toEqual({
      value: '{"enabled":true}',
    });
    backup.close();

    const after = new Database(join(dataDir, STATE_DB_FILE), { readonly: true });
    expect(after.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined();
    expect(after.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 });
    after.close();
  });

  it('refuses an unknown migration history', async () => {
    const dataDir = tempDir();
    (await openLocalStore({ dataDir })).close();
    const raw = new Database(join(dataDir, STATE_DB_FILE));
    raw.prepare(`UPDATE schema_migrations SET name = 'something-else' WHERE version = 1`).run();
    raw.close();
    expect((await failure(openLocalStore({ dataDir }))).details['reason']).toBe('unknown-migration');
  });

  it('leaves a corrupt database untouched', async () => {
    const dataDir = tempDir();
    const file = join(dataDir, STATE_DB_FILE);
    writeFileSync(file, Buffer.alloc(8192, 0x5a));
    const before = sha(file);
    const err = await failure(openLocalStore({ dataDir }));
    expect(err.code).toBe('STORAGE_IO_FAILED');
    expect(sha(file)).toBe(before);
  });
});

const now = () => new Date().toISOString();
const oid = (c: string) => c.repeat(40);

function saveOp(projectId: string, over: Partial<OperationRecord> = {}): OperationRecord {
  const at = now();
  const journal: OperationJournal = { kind: 'save', publish: null, snapshot: null, error: null };
  return {
    operationId: OperationId.parse(randomUUID()),
    projectId: ProjectId.parse(projectId),
    kind: 'save',
    origin: 'gui',
    state: 'confirmed',
    createdAt: at,
    updatedAt: at,
    acknowledged: false,
    journal,
    ...over,
  };
}

function plan(projectId: string): StoredPlan {
  const at = now();
  return {
    planId: PlanId.parse(randomUUID()),
    projectId: ProjectId.parse(projectId),
    createdAt: at,
    expiresAt: at,
    fingerprint: 'f'.repeat(64),
    record: { kind: 'recovery', operationId: OperationId.parse(randomUUID()), strategy: 'finish' },
    consumedBy: null,
  };
}

describe('the operation journal', () => {
  it('moves an operation only from the state the caller saw, and keeps it across reopen', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    const projectId = randomUUID();
    const op = saveOp(projectId);
    store.insertOperation(op);
    const publish = {
      step: 'final' as const,
      ref: 'refs/heads/main',
      expectedOld: null,
      commit: oid('a'),
      tree: oid('b'),
      snapshotId: null,
    };
    const journal: OperationJournal = { kind: 'save', publish, snapshot: null, error: null };
    expect(store.updateOperation(op.operationId, ['preflight'], { state: 'publishing', journal, at: now() })).toBe(
      false,
    );
    expect(store.updateOperation(op.operationId, ['confirmed'], { state: 'publishing', journal, at: now() })).toBe(
      true,
    );
    expect(store.updateOperation(op.operationId, ['confirmed'], { state: 'failed', journal, at: now() })).toBe(false);
    store.close();

    const again = await openLocalStore({ dataDir });
    expect(again.getOperation(op.operationId)).toMatchObject({ state: 'publishing', journal: { publish } });
    again.close();
  });

  it('lists by project, kind, state and notice, oldest or newest first', async () => {
    const store = await openLocalStore({ dataDir: tempDir() });
    const a = randomUUID();
    const b = randomUUID();
    const ops = [
      saveOp(a, { state: 'completed' }),
      saveOp(a, { state: 'recovery-required' }),
      saveOp(b, { state: 'completed', origin: 'mcp' }),
    ];
    for (const op of ops) store.insertOperation(op);
    store.acknowledgeOperation(ops[0]?.operationId as OperationId);
    const ids = (q: Parameters<typeof store.listOperations>[0]) => store.listOperations(q).map((r) => r.operationId);
    expect(ids({ projectId: ProjectId.parse(a) })).toEqual([ops[0]?.operationId, ops[1]?.operationId]);
    expect(ids({ states: ['completed'] })).toEqual([ops[0]?.operationId, ops[2]?.operationId]);
    expect(ids({ states: ['completed'], newestFirst: true, limit: 1 })).toEqual([ops[2]?.operationId]);
    expect(ids({ unacknowledged: true, kinds: ['save'] })).toEqual([ops[1]?.operationId, ops[2]?.operationId]);
    expect(ids({ states: [] })).toEqual([]);
    store.close();
  });

  it("records a restore's files and their progress", async () => {
    const store = await openLocalStore({ dataDir: tempDir() });
    const op = saveOp(randomUUID());
    store.insertOperation(op);
    store.insertOperationFiles(op.operationId, [
      { seq: 0, path: 'gone.html', before: { oid: oid('1'), mode: '100644' }, after: null, done: false },
      { seq: 1, path: '新/頁.html', before: null, after: { oid: oid('2'), mode: '100755' }, done: false },
    ]);
    store.markOperationFile(op.operationId, 1, true);
    expect(store.listOperationFiles(op.operationId)).toEqual([
      { seq: 0, path: 'gone.html', before: { oid: oid('1'), mode: '100644' }, after: null, done: false },
      { seq: 1, path: '新/頁.html', before: null, after: { oid: oid('2'), mode: '100755' }, done: true },
    ]);
    store.close();
  });

  it('lets a plan be applied once, starting its operation in the same transaction', async () => {
    const store = await openLocalStore({ dataDir: tempDir() });
    const projectId = randomUUID();
    const p = plan(projectId);
    store.insertPlan(p);
    expect(store.getPlan(p.planId)).toEqual(p);
    const first = saveOp(projectId);
    const second = saveOp(projectId);
    expect(store.consumePlan(p.planId, first.operationId, now(), first)).toBe(true);
    expect(store.consumePlan(p.planId, second.operationId, now(), second)).toBe(false);
    expect(store.getPlan(p.planId)?.consumedBy).toBe(first.operationId);
    expect(store.getOperation(first.operationId)).not.toBeNull();
    expect(store.getOperation(second.operationId)).toBeNull();
    store.close();
  });

  it('forgets old ended operations and plans, never unfinished ones', async () => {
    const store = await openLocalStore({ dataDir: tempDir() });
    const projectId = randomUUID();
    const old = '2020-01-01T00:00:00.000Z';
    const ended = saveOp(projectId, { state: 'completed', updatedAt: old });
    const open = saveOp(projectId, { state: 'recovery-required', updatedAt: old });
    for (const op of [ended, open]) store.insertOperation(op);
    store.insertOperationFiles(ended.operationId, [
      { seq: 0, path: 'a', before: null, after: { oid: oid('3'), mode: '100644' }, done: true },
    ]);
    const stalePlan = { ...plan(projectId), expiresAt: old };
    store.insertPlan(stalePlan);
    store.prune(now());
    expect(store.getOperation(ended.operationId)).toBeNull();
    expect(store.listOperationFiles(ended.operationId)).toEqual([]);
    expect(store.getOperation(open.operationId)).not.toBeNull();
    expect(store.getPlan(stalePlan.planId)).toBeNull();
    store.close();
  });

  it('reports a damaged record instead of guessing around it', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    const op = saveOp(randomUUID());
    store.insertOperation(op);
    store.close();
    const raw = new Database(join(dataDir, STATE_DB_FILE));
    raw.prepare('UPDATE operations SET data = ? WHERE operation_id = ?').run('{"kind":"save"}', op.operationId);
    raw.close();
    const again = await openLocalStore({ dataDir });
    const err = (() => {
      try {
        again.getOperation(op.operationId);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toMatchObject({ code: 'STORAGE_IO_FAILED', details: { reason: 'corrupt-record' } });
    again.close();
  });

  it('migrates a version-1 database, keeping its settings and a backup', async () => {
    const dataDir = tempDir();
    const v1 = await openLocalStore({ dataDir, migrations: MIGRATIONS.filter((m) => m.version === 1) });
    v1.setAgentAccess(true, now());
    v1.close();
    const v2 = await openLocalStore({ dataDir });
    expect(v2.storageSchemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(v2.getAgentAccess().enabled).toBe(true);
    expect(v2.listOperations({})).toEqual([]);
    expect(v2.listPreviews()).toEqual([]);
    v2.close();
    expect(readdirSync(dataDir).filter((f) => f.startsWith(`${STATE_DB_FILE}.backup-v1-`))).toHaveLength(1);
  });
});

describe('the preview cache', () => {
  const projectId = ProjectId.parse(randomUUID());
  const image = (bytes: number) => ({ width: 1280, height: 800, bytes, sha256: 'a'.repeat(64) });
  const record: PreviewRecord = {
    subject: { kind: 'page', path: 'index.html' },
    image: image(1000),
    thumbnail: { ...image(100), width: 400, height: 250 },
    renderedAt: '2026-10-02T00:00:00.000Z',
    missing: { count: 1, entries: [{ path: 'logo.png', reason: 'not-in-version' }] },
    blocked: { count: 0, entries: [] },
    settings: {
      viewport: { width: 1280, height: 800, scale: 1 },
      thumbnail: { width: 400, height: 250 },
      locale: 'en-US',
      timezone: 'Asia/Taipei',
      scripts: true,
      wait: 'load+fonts+2-frames+300ms',
      animations: 'jump-to-end',
    },
    environment: {
      renderer: 'electron/1 chromium/2',
      electron: '1',
      chromium: '2',
      platform: 'darwin',
      osRelease: '27.0.0',
    },
  };
  const entry = (key: string, usedAt: string): StoredPreview => ({
    projectId,
    key: key.repeat(64),
    createdAt: usedAt,
    usedAt,
    bytes: 1100,
    record,
  });

  it('keeps previews across reopen, least recently used first', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    store.putPreview(entry('a', '2026-10-02T00:00:01.000Z'));
    store.putPreview(entry('b', '2026-10-02T00:00:02.000Z'));
    store.touchPreview(projectId, 'a'.repeat(64), '2026-10-02T00:00:03.000Z');
    store.close();
    const again = await openLocalStore({ dataDir });
    expect(again.getPreview(projectId, 'a'.repeat(64))).toEqual({
      ...entry('a', '2026-10-02T00:00:01.000Z'),
      usedAt: '2026-10-02T00:00:03.000Z',
    });
    expect(again.listPreviews().map((p) => p.key[0])).toEqual(['b', 'a']);
    // Rendering the same key again replaces the row.
    again.putPreview({ ...entry('b', '2026-10-02T00:00:04.000Z'), bytes: 7 });
    expect(again.listPreviews().map((p) => [p.key[0], p.bytes])).toEqual([
      ['a', 1100],
      ['b', 7],
    ]);
    again.deletePreview(projectId, 'a'.repeat(64));
    expect(again.getPreview(projectId, 'a'.repeat(64))).toBeNull();
    expect(again.getPreview(ProjectId.parse(randomUUID()), 'b'.repeat(64))).toBeNull();
    again.close();
  });

  it('drops a row it cannot read back instead of failing: it is a cache', async () => {
    const dataDir = tempDir();
    const store = await openLocalStore({ dataDir });
    store.putPreview(entry('c', '2026-10-02T00:00:01.000Z'));
    store.close();
    const raw = new Database(join(dataDir, STATE_DB_FILE));
    raw.prepare('UPDATE preview_cache SET data = ?').run('{"subject":{"kind":"page"}}');
    raw.close();
    const again = await openLocalStore({ dataDir });
    expect(again.getPreview(projectId, 'c'.repeat(64))).toBeNull();
    expect(again.listPreviews()).toEqual([]);
    again.close();
  });

  it('migrates a version-2 database with a backup, keeping the journal', async () => {
    const dataDir = tempDir();
    const v2 = await openLocalStore({ dataDir, migrations: MIGRATIONS.filter((m) => m.version <= 2) });
    v2.setAgentAccess(true, now());
    v2.close();
    const v3 = await openLocalStore({ dataDir });
    expect(v3.storageSchemaVersion).toBe(3);
    expect(v3.getAgentAccess().enabled).toBe(true);
    expect(v3.listPreviews()).toEqual([]);
    v3.close();
    expect(readdirSync(dataDir).filter((f) => f.startsWith(`${STATE_DB_FILE}.backup-v2-`))).toHaveLength(1);
  });
});

describe('engine lock', () => {
  it('admits one holder at a time within a process', () => {
    const file = join(tempDir(), 'engine.lock.sqlite');
    const first = tryAcquireEngineLock(file);
    expect(first).not.toBeNull();
    expect(tryAcquireEngineLock(file)).toBeNull();
    first?.release();
    const again = tryAcquireEngineLock(file);
    expect(again).not.toBeNull();
    again?.release();
  });

  it('stays held while the holder lives and is released by the kernel when it is killed', async () => {
    const file = join(tempDir(), 'engine.lock.sqlite');
    const lockModule = pathToFileURL(fileURLToPath(new URL('../src/engine-lock.ts', import.meta.url))).href;
    // The child drops the handle and forces a GC: the lock must survive that
    // (a collected connection would otherwise close and release it).
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(lockModule)});
         const got = m.tryAcquireEngineLock(${JSON.stringify(file)}) !== null;
         for (let i = 0; i < 3; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
         console.log(got ? 'held' : 'busy');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const line = await new Promise<string>((resolve) =>
        child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim())),
      );
      expect(line).toBe('held');
      expect(tryAcquireEngineLock(file)).toBeNull();
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    const taken = tryAcquireEngineLock(file);
    expect(taken).not.toBeNull();
    taken?.release();
  });
});
