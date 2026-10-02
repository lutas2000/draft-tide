import type Database from 'better-sqlite3';

// Ordered, append-only. Never edit a shipped migration; add a new one. Each
// runs in its own transaction together with its row in schema_migrations.
// Tables arrive with the work package that first needs them (remote bindings
// and the sync queue with M1-07).
export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'settings-and-bindings',
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- One binding per canonical root; one root per project on this computer.
        CREATE TABLE project_bindings (
          project_id TEXT PRIMARY KEY,
          root TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          bound_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: 'operation-journal-and-plans',
    up(db) {
      // The journal (TECH_STACK §6.4): one row per operation, written before
      // each step. data holds the kind-specific details as JSON (contracts
      // journal.ts). project_id is null for requests that name no project.
      // A restore's file changes have their own table. Plans wait for their
      // apply; consumed_by makes each one usable once.
      db.exec(`
        CREATE TABLE operations (
          operation_id TEXT PRIMARY KEY,
          project_id TEXT,
          kind TEXT NOT NULL,
          origin TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          acknowledged INTEGER NOT NULL DEFAULT 0,
          data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX operations_by_project ON operations (project_id, state);
        CREATE INDEX operations_by_state ON operations (state, kind);

        CREATE TABLE operation_files (
          operation_id TEXT NOT NULL REFERENCES operations (operation_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          path TEXT NOT NULL,
          before_oid TEXT,
          before_mode TEXT,
          after_oid TEXT,
          after_mode TEXT,
          done INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (operation_id, seq)
        ) STRICT;

        CREATE TABLE plans (
          plan_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          data TEXT NOT NULL,
          consumed_by TEXT,
          consumed_at TEXT
        ) STRICT;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
