import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveDataDir(explicit?: string): string {
  const v = explicit ?? process.env['DRAFT_TIDE_DATA_DIR'];
  if (v) return resolve(v);
  return join(homedir(), 'Library', 'Application Support', 'Draft Tide M0 Spike');
}

export interface RuntimePaths {
  runtimeDir: string;
  lockDb: string;
  discovery: string;
  desktopToken: string;
  socket: string;
}

// macOS limits sun_path to 104 bytes; long data dirs fall back to a per-user
// temp location keyed by the data dir (TMPDIR is 0700 per user on macOS).
export function runtimePaths(dataDir: string): RuntimePaths {
  const runtimeDir = join(dataDir, 'runtime');
  let socket = join(runtimeDir, 'engine.sock');
  if (Buffer.byteLength(socket) > 100) {
    socket = join(tmpdir(), `dt-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.sock`);
  }
  return {
    runtimeDir,
    lockDb: join(runtimeDir, 'engine.lock.sqlite'),
    discovery: join(runtimeDir, 'engine.json'),
    desktopToken: join(runtimeDir, 'desktop.token'),
    socket,
  };
}
