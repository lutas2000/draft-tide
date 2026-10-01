import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

// Overrides the data store location. Used by tests and development; each data
// store gets its own Engine.
export const DATA_DIR_ENV = 'DRAFT_TIDE_DATA_DIR';

// Path rules of the target platform, so callers (and tests) can ask about
// another platform than the host's.
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function defaultDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  const path = pathFor(platform);
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Draft Tide');
  if (platform === 'win32') {
    return path.join(env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming'), 'Draft Tide');
  }
  return path.join(env['XDG_DATA_HOME'] ?? path.join(homedir(), '.local', 'share'), 'draft-tide');
}

export function resolveDataDir(explicit?: string): string {
  const path = pathFor(process.platform);
  const fromEnv = process.env[DATA_DIR_ENV];
  if (explicit) return path.resolve(explicit);
  if (fromEnv) return path.resolve(fromEnv);
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
  const path = pathFor(platform);
  const root = path.resolve(dataDir);
  const runtimeDir = path.join(root, 'runtime');
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
  let socket: string;
  if (platform === 'win32') {
    socket = `\\\\.\\pipe\\draft-tide-${key}`;
  } else {
    socket = path.join(runtimeDir, 'engine.sock');
    // sun_path holds 104 bytes on macOS and 108 on Linux. Long data dirs fall
    // back to the per-user runtime or temp directory (0700 on macOS).
    if (Buffer.byteLength(socket) > 100) {
      const base = platform === 'linux' ? (process.env['XDG_RUNTIME_DIR'] ?? tmpdir()) : tmpdir();
      socket = path.join(base, `draft-tide-${key}.sock`);
    }
  }
  return {
    runtimeDir,
    lockFile: path.join(runtimeDir, 'engine.lock.sqlite'),
    discoveryFile: path.join(runtimeDir, 'engine.json'),
    socket,
  };
}
