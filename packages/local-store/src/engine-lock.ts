import Database from 'better-sqlite3';

// One Engine per data store (TECH_STACK §3.1). The lock is an EXCLUSIVE
// SQLite transaction held for the Engine's lifetime: an OS-level file lock
// (fcntl / LockFileEx) that the kernel releases when the process dies, so a
// crashed Engine never needs pid or file-age guessing to be replaced. Verified
// in M0 (12 racing cold starts reached one Engine; takeover after kill -9 in
// about 200 ms).
export interface EngineLock {
  release(): void;
}

export function tryAcquireEngineLock(file: string): EngineLock | null {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 0');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    db.close();
    const code = (e as { code?: unknown }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return null;
    throw e;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    },
  };
}
