import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DtError,
  type AgentAccess,
  type IsoTimestamp,
  type ProjectId,
  type ProjectSummary,
} from '@draft-tide/contracts';
import type { LocalStore } from '@draft-tide/core';
import { MIGRATIONS, type Migration } from './migrations.ts';

export const STATE_DB_FILE = 'state.sqlite';

export interface OpenLocalStoreOptions {
  dataDir: string;
  // Tests substitute their own list; the Engine always uses MIGRATIONS.
  migrations?: readonly Migration[];
}

export interface LocalStoreHandle extends LocalStore {
  readonly file: string;
  close(): void;
}

// Opens (creating if needed) the Engine's state database. Only the Engine
// calls this; every other process goes through the Engine.
//
// - A database that fails its integrity check is left untouched and nothing
//   writes to it (STORAGE_IO_FAILED). It is never deleted and rebuilt: it is
//   not a cache (TECH_STACK §6.2).
// - A database from a newer Draft Tide is refused before anything writes.
// - Before migrating an existing database, a consistent backup (WAL included)
//   is written next to it.
export async function openLocalStore(options: OpenLocalStoreOptions): Promise<LocalStoreHandle> {
  const migrations = options.migrations ?? MIGRATIONS;
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const file = join(options.dataDir, STATE_DB_FILE);
  const existed = existsSync(file);
  let db: Database.Database;
  try {
    db = new Database(file);
  } catch (e) {
    throw storageError('open-failed', e);
  }
  try {
    db.pragma('busy_timeout = 5000');
    if (existed) checkIntegrity(db);
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal')
      throw new DtError('STORAGE_IO_FAILED', 'the local database cannot use WAL mode', { reason: 'no-wal' });
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    await migrate(db, file, migrations);
  } catch (e) {
    db.close();
    throw e instanceof DtError ? e : storageError('open-failed', e);
  }
  return new SqliteLocalStore(db, file, migrations);
}

function storageError(reason: string, cause: unknown): DtError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new DtError('STORAGE_IO_FAILED', `local database: ${message}`, { reason });
}

function checkIntegrity(db: Database.Database): void {
  let result: unknown;
  try {
    result = db.pragma('quick_check', { simple: true });
  } catch (e) {
    throw storageError('integrity-check-failed', e);
  }
  if (result !== 'ok') {
    throw new DtError('STORAGE_IO_FAILED', 'the local database failed its integrity check; nothing was written', {
      reason: 'integrity-check-failed',
    });
  }
}

interface AppliedRow {
  version: number;
  name: string;
}

async function migrate(db: Database.Database, file: string, migrations: readonly Migration[]): Promise<void> {
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  const applied = hasTable
    ? (db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as AppliedRow[])
    : [];
  const current = applied.reduce((max, r) => Math.max(max, r.version), 0);
  if (current > latest) {
    throw new DtError('PROTOCOL_MISMATCH', 'local data was written by a newer Draft Tide; update the app', {
      storageSchemaVersion: current,
      supportedStorageSchemaVersion: latest,
    });
  }
  for (const row of applied) {
    const known = migrations.find((m) => m.version === row.version);
    if (known?.name !== row.name) {
      throw new DtError(
        'STORAGE_IO_FAILED',
        'the local database has an unknown migration history; nothing was written',
        {
          reason: 'unknown-migration',
          version: row.version,
        },
      );
    }
  }
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;
  if (current > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await db.backup(`${file}.backup-v${current}-${stamp}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name, new Date().toISOString());
    })();
  }
}

const AGENT_ACCESS_KEY = 'agent_access';
const AGENT_ACCESS_OFF: AgentAccess = { enabled: false, updatedAt: null };

interface ProjectRow {
  project_id: string;
  name: string;
  root: string;
  bound_at: string;
}

function toSummary(r: ProjectRow): ProjectSummary {
  return { projectId: r.project_id, name: r.name, root: r.root, boundAt: r.bound_at } as ProjectSummary;
}

class SqliteLocalStore implements LocalStoreHandle {
  readonly storageSchemaVersion: number;
  readonly sqliteVersion: string;
  readonly file: string;
  readonly #db: Database.Database;

  constructor(db: Database.Database, file: string, migrations: readonly Migration[]) {
    this.#db = db;
    this.file = file;
    this.storageSchemaVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
    this.sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  }

  // Anything unexpected in the stored value reads as "off".
  getAgentAccess(): AgentAccess {
    const row = this.#db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get(AGENT_ACCESS_KEY) as
      { value: string; updated_at: string } | undefined;
    if (!row) return AGENT_ACCESS_OFF;
    try {
      const v = JSON.parse(row.value) as unknown;
      if (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true) {
        return { enabled: true, updatedAt: row.updated_at };
      }
      return { enabled: false, updatedAt: row.updated_at };
    } catch {
      return AGENT_ACCESS_OFF;
    }
  }

  setAgentAccess(enabled: boolean, at: IsoTimestamp): AgentAccess {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(AGENT_ACCESS_KEY, JSON.stringify({ enabled }), at);
    return { enabled, updatedAt: at };
  }

  // Shapes are checked against the contract by core before they leave.
  listProjects(): ProjectSummary[] {
    const rows = this.#db
      .prepare('SELECT project_id, name, root, bound_at FROM project_bindings ORDER BY bound_at, project_id')
      .all() as ProjectRow[];
    return rows.map(toSummary);
  }

  getProject(projectId: ProjectId): ProjectSummary | null {
    const row = this.#db
      .prepare('SELECT project_id, name, root, bound_at FROM project_bindings WHERE project_id = ?')
      .get(projectId) as ProjectRow | undefined;
    return row ? toSummary(row) : null;
  }

  findProjectByRoot(root: string): ProjectSummary | null {
    const row = this.#db
      .prepare('SELECT project_id, name, root, bound_at FROM project_bindings WHERE root = ?')
      .get(root) as ProjectRow | undefined;
    return row ? toSummary(row) : null;
  }

  // The table's keys refuse a second binding of a project or of a root.
  insertProject(project: ProjectSummary): void {
    this.#db
      .prepare('INSERT INTO project_bindings (project_id, root, name, bound_at) VALUES (?, ?, ?, ?)')
      .run(project.projectId, project.root, project.name, project.boundAt);
  }

  updateProject(projectId: ProjectId, changes: { root?: string; name?: string }): void {
    const current = this.getProject(projectId);
    if (!current) throw new DtError('PROJECT_NOT_BOUND', 'no connected project has this id', { projectId });
    this.#db
      .prepare('UPDATE project_bindings SET root = ?, name = ? WHERE project_id = ?')
      .run(changes.root ?? current.root, changes.name ?? current.name, projectId);
  }

  close(): void {
    this.#db.close();
  }
}
