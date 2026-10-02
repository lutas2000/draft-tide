import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DtError,
  OperationJournal,
  OperationKind,
  OperationState,
  Origin,
  PlanRecord,
  TERMINAL_OPERATION_STATES,
  type AgentAccess,
  type IsoTimestamp,
  type OperationId,
  type PlanId,
  type ProjectId,
  type ProjectSummary,
} from '@draft-tide/contracts';
import type {
  FileState,
  LocalStore,
  OperationFile,
  OperationQuery,
  OperationRecord,
  StoredPlan,
} from '@draft-tide/core';
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

interface OperationRow {
  operation_id: string;
  project_id: string | null;
  kind: string;
  origin: string;
  state: string;
  created_at: string;
  updated_at: string;
  acknowledged: number;
  data: string;
}

interface FileRow {
  seq: number;
  path: string;
  before_oid: string | null;
  before_mode: string | null;
  after_oid: string | null;
  after_mode: string | null;
  done: number;
}

interface PlanRow {
  plan_id: string;
  project_id: string;
  created_at: string;
  expires_at: string;
  fingerprint: string;
  data: string;
  consumed_by: string | null;
}

// A stored row that doesn't read back as written is a damaged database:
// reported, never guessed around (TECH_STACK §6.2).
function corrupt(what: string): DtError {
  return new DtError('STORAGE_IO_FAILED', `the local database holds an unreadable ${what}`, {
    reason: 'corrupt-record',
  });
}

function parseJson<T>(
  text: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  what: string,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt(what);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw corrupt(what);
  return parsed.data;
}

function toOperation(r: OperationRow): OperationRecord {
  const kind = OperationKind.safeParse(r.kind);
  const origin = Origin.safeParse(r.origin);
  const state = OperationState.safeParse(r.state);
  if (!kind.success || !origin.success || !state.success) throw corrupt('operation');
  const journal = parseJson(r.data, OperationJournal, 'operation');
  if (journal.kind !== kind.data) throw corrupt('operation');
  return {
    operationId: r.operation_id as OperationId,
    projectId: r.project_id as ProjectId | null,
    kind: kind.data,
    origin: origin.data,
    state: state.data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    acknowledged: r.acknowledged !== 0,
    journal,
  };
}

const OID = /^[0-9a-f]{40}$/;

function fileState(oid: string | null, mode: string | null): FileState | null {
  if (oid === null && mode === null) return null;
  if (oid === null || !OID.test(oid) || (mode !== '100644' && mode !== '100755')) throw corrupt('operation file');
  return { oid, mode };
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

  // ---- The operation journal

  insertOperation(op: OperationRecord): void {
    this.#db
      .prepare(
        `INSERT INTO operations (operation_id, project_id, kind, origin, state, created_at, updated_at, acknowledged, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.operationId,
        op.projectId,
        op.kind,
        op.origin,
        op.state,
        op.createdAt,
        op.updatedAt,
        op.acknowledged ? 1 : 0,
        JSON.stringify(op.journal),
      );
  }

  updateOperation(
    operationId: OperationId,
    expect: readonly OperationState[],
    change: { state: OperationState; journal: OperationJournal; at: IsoTimestamp },
  ): boolean {
    if (expect.length === 0) return false;
    const r = this.#db
      .prepare(
        `UPDATE operations SET state = ?, data = ?, updated_at = ?
         WHERE operation_id = ? AND state IN (${expect.map(() => '?').join(', ')})`,
      )
      .run(change.state, JSON.stringify(change.journal), change.at, operationId, ...expect);
    return r.changes === 1;
  }

  getOperation(operationId: OperationId): OperationRecord | null {
    const row = this.#db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId) as
      OperationRow | undefined;
    return row ? toOperation(row) : null;
  }

  listOperations(query: OperationQuery): OperationRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(query.projectId);
    }
    for (const [column, values] of [
      ['kind', query.kinds],
      ['state', query.states],
    ] as const) {
      if (values === undefined) continue;
      if (values.length === 0) return [];
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    }
    if (query.unacknowledged) where.push('acknowledged = 0');
    const order = query.newestFirst ? 'DESC' : 'ASC';
    const sql = `SELECT * FROM operations ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at ${order}, rowid ${order} ${query.limit !== undefined ? 'LIMIT ?' : ''}`;
    if (query.limit !== undefined) params.push(query.limit);
    return (this.#db.prepare(sql).all(...params) as OperationRow[]).map(toOperation);
  }

  acknowledgeOperation(operationId: OperationId): void {
    this.#db.prepare('UPDATE operations SET acknowledged = 1 WHERE operation_id = ?').run(operationId);
  }

  insertOperationFiles(operationId: OperationId, files: readonly OperationFile[]): void {
    const insert = this.#db.prepare(
      `INSERT INTO operation_files (operation_id, seq, path, before_oid, before_mode, after_oid, after_mode, done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const f of files) {
        insert.run(
          operationId,
          f.seq,
          f.path,
          f.before?.oid ?? null,
          f.before?.mode ?? null,
          f.after?.oid ?? null,
          f.after?.mode ?? null,
          f.done ? 1 : 0,
        );
      }
    })();
  }

  listOperationFiles(operationId: OperationId): OperationFile[] {
    const rows = this.#db
      .prepare('SELECT * FROM operation_files WHERE operation_id = ? ORDER BY seq')
      .all(operationId) as FileRow[];
    return rows.map((r) => ({
      seq: r.seq,
      path: r.path,
      before: fileState(r.before_oid, r.before_mode),
      after: fileState(r.after_oid, r.after_mode),
      done: r.done !== 0,
    }));
  }

  markOperationFile(operationId: OperationId, seq: number, done: boolean): void {
    this.#db
      .prepare('UPDATE operation_files SET done = ? WHERE operation_id = ? AND seq = ?')
      .run(done ? 1 : 0, operationId, seq);
  }

  // ---- Plans

  insertPlan(plan: StoredPlan): void {
    this.#db
      .prepare(
        `INSERT INTO plans (plan_id, project_id, created_at, expires_at, fingerprint, data, consumed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.planId,
        plan.projectId,
        plan.createdAt,
        plan.expiresAt,
        plan.fingerprint,
        JSON.stringify(plan.record),
        plan.consumedBy,
      );
  }

  getPlan(planId: PlanId): StoredPlan | null {
    const row = this.#db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as PlanRow | undefined;
    if (!row) return null;
    return {
      planId: row.plan_id as PlanId,
      projectId: row.project_id as ProjectId,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      fingerprint: row.fingerprint,
      record: parseJson(row.data, PlanRecord, 'plan'),
      consumedBy: row.consumed_by as OperationId | null,
    };
  }

  consumePlan(planId: PlanId, by: OperationId, at: IsoTimestamp, start?: OperationRecord): boolean {
    return this.#db.transaction(() => {
      const r = this.#db
        .prepare('UPDATE plans SET consumed_by = ?, consumed_at = ? WHERE plan_id = ? AND consumed_by IS NULL')
        .run(by, at, planId);
      if (r.changes !== 1) return false;
      if (start) this.insertOperation(start);
      return true;
    })();
  }

  prune(before: IsoTimestamp): void {
    const ended = [...TERMINAL_OPERATION_STATES];
    this.#db.transaction(() => {
      this.#db
        .prepare(`DELETE FROM operations WHERE updated_at < ? AND state IN (${ended.map(() => '?').join(', ')})`)
        .run(before, ...ended);
      this.#db.prepare('DELETE FROM plans WHERE expires_at < ?').run(before);
    })();
  }

  close(): void {
    this.#db.close();
  }
}
