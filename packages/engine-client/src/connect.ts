import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DtError, Discovery, PROTOCOL_VERSION, type Channel } from '@draft-tide/contracts';
import { EngineConnection } from './connection.ts';
import { DATA_DIR_ENV, resolveDataDir, runtimePaths } from './paths.ts';

// How to start the Engine. Release builds run the Engine executable itself (a
// Node SEA that carries --disable-sigusr1 in its own configuration and takes
// no Node options); development builds run the Engine script on the companion
// Node (scriptEngineLaunch). Never Electron's Node or the user's PATH.
export interface EngineLaunch {
  command: string;
  args: string[];
  // Extra variables for the Engine (development knobs). The rest of the
  // environment is built from scratch.
  env?: Record<string, string>;
}

// The Engine script on the companion Node (development and tests).
// --disable-sigusr1: otherwise any same-user process can open an inspector in
// the Engine with SIGUSR1 (desktop-auth spike C1, E4). The minimal PATH is
// where a development Engine looks for Git.
export function scriptEngineLaunch(
  nodePath: string,
  engineEntry: string,
  env: Record<string, string> = {},
): EngineLaunch {
  return {
    command: nodePath,
    args: ['--disable-sigusr1', engineEntry],
    env: { ...(process.platform === 'win32' ? {} : { PATH: '/usr/bin:/bin' }), ...env },
  };
}

export interface ConnectOptions {
  channel: Channel;
  client: { name: string; version: string };
  dataDir?: string;
  // How to start an Engine when none is running; omit to only connect.
  launch?: EngineLaunch;
  timeoutMs?: number;
}

// Connects to the data store's Engine, starting it on demand. Several clients
// may race to start one: each may spawn an Engine, the startup lock admits
// exactly one, and the others exit at once. Never falls back to doing the
// work in-process.
export async function connectEngine(options: ConnectOptions): Promise<EngineConnection> {
  const dataDir = resolveDataDir(options.dataDir);
  const existing = await tryConnect(dataDir, options);
  if (existing) return existing;
  if (!options.launch) throw new DtError('ENGINE_UNAVAILABLE', 'the Draft Tide Engine is not running');

  startEngine(dataDir, options.launch);
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let delay = 25;
  let last: unknown = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 250);
    try {
      const conn = await tryConnect(dataDir, options);
      if (conn) return conn;
    } catch (e) {
      // A definite answer from a running Engine ends the wait.
      if (e instanceof DtError && e.code !== 'ENGINE_UNAVAILABLE') throw e;
      last = e;
    }
  }
  throw new DtError('ENGINE_UNAVAILABLE', 'the Draft Tide Engine did not start in time', {
    lastError: last instanceof Error ? last.message : null,
  });
}

function readDiscovery(file: string): Discovery | null {
  try {
    const parsed = Discovery.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function tryConnect(dataDir: string, options: ConnectOptions): Promise<EngineConnection | null> {
  const paths = runtimePaths(dataDir);
  const discovery = readDiscovery(paths.discoveryFile);
  if (!discovery) return null;
  let conn: EngineConnection;
  try {
    conn = await EngineConnection.open(discovery.socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      channel: options.channel,
      client: options.client,
      ...(options.channel === 'desktop' ? {} : { toolToken: discovery.toolToken }),
    });
  } catch (e) {
    // Stale discovery from an Engine that is gone: the next one replaces it.
    if (e instanceof DtError && e.code === 'ENGINE_UNAVAILABLE') return null;
    // Rejected by a newer Engine that replaced the one we read about (our
    // token was the old one): retry with the current file.
    if (readDiscovery(paths.discoveryFile)?.instanceId !== discovery.instanceId) return null;
    throw e;
  }
  if (conn.instanceId !== discovery.instanceId) {
    conn.close();
    return null;
  }
  return conn;
}

// Only these variables reach the Engine; nothing else from the caller's
// environment does (no NODE_OPTIONS, GIT_*, proxies or tokens). On macOS they
// are within the release Engine's allowlist, which refuses to start with
// anything else (CLAUDE.md "Engine environment").
export function engineEnvironment(
  dataDir: string,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { [DATA_DIR_ENV]: dataDir };
  const keep =
    platform === 'win32'
      ? ['SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP']
      : [
          'HOME',
          'TMPDIR',
          'USER',
          'LOGNAME',
          'LANG',
          'LC_ALL',
          ...(platform === 'linux' ? ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME'] : []),
        ];
  for (const k of keep) {
    const v = from[k];
    if (v) env[k] = v;
  }
  return { ...env, ...extra };
}

function startEngine(dataDir: string, launch: EngineLaunch): void {
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: engineEnvironment(dataDir, launch.env ?? {}),
  });
  child.on('error', () => undefined);
  child.unref();
}
