import type Database from 'better-sqlite3';

// Ordered, append-only. Never edit a shipped migration; add a new one. Each
// runs in its own transaction together with its row in schema_migrations.
// Tables arrive with the work package that first needs them (operations and
// plans with M1-05, remote bindings and the sync queue with M1-07).
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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
