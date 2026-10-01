import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { DtError, ProjectId } from '@draft-tide/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, STATE_DB_FILE, openLocalStore, tryAcquireEngineLock, type Migration } from '../src/index.ts';

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
    const v1 = await openLocalStore({ dataDir });
    v1.setAgentAccess(true, new Date().toISOString());
    v1.close();

    const broken: Migration[] = [
      ...MIGRATIONS,
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
