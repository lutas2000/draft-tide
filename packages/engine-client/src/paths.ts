import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Overrides the data store location. Used by tests and development; each data
// store gets its own Engine.
export const DATA_DIR_ENV = 'DRAFT_TIDE_DATA_DIR';

export function defaultDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Draft Tide');
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Draft Tide');
  return join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'draft-tide');
}

export function resolveDataDir(explicit?: string): string {
  const fromEnv = process.env[DATA_DIR_ENV];
  if (explicit) return resolve(explicit);
  if (fromEnv) return resolve(fromEnv);
  return defaultDataDir();
}

export interface RuntimePaths {
  runtimeDir: string;
  lockFile: string;
  discoveryFile: string;
  socket: string;
}

// The socket (named pipe on Windows) and the files that find it. The socket
// path is not authorization; the Engine still checks every connection.
export function runtimePaths(dataDir: string, platform: NodeJS.Platform = process.platform): RuntimePaths {
  const root = resolve(dataDir);
  const runtimeDir = join(root, 'runtime');
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
  let socket: string;
  if (platform === 'win32') {
    socket = `\\\\.\\pipe\\draft-tide-${key}`;
  } else {
    socket = join(runtimeDir, 'engine.sock');
    // sun_path holds 104 bytes on macOS and 108 on Linux. Long data dirs fall
    // back to the per-user runtime or temp directory (0700 on macOS).
    if (Buffer.byteLength(socket) > 100) {
      const base = platform === 'linux' ? (process.env['XDG_RUNTIME_DIR'] ?? tmpdir()) : tmpdir();
      socket = join(base, `draft-tide-${key}.sock`);
    }
  }
  return {
    runtimeDir,
    lockFile: join(runtimeDir, 'engine.lock.sqlite'),
    discoveryFile: join(runtimeDir, 'engine.json'),
    socket,
  };
}
