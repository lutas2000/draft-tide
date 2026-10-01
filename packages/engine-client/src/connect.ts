import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DtError, Discovery, PROTOCOL_VERSION, type Channel } from '@draft-tide/contracts';
import { EngineConnection } from './connection.ts';
import { DATA_DIR_ENV, resolveDataDir, runtimePaths } from './paths.ts';

export interface EngineLaunch {
  // The bundled companion Node, never Electron's Node or the user's PATH.
  nodePath: string;
  engineEntry: string;
  // Extra variables for the Engine (development knobs). The rest of the
  // environment is built from scratch.
  env?: Record<string, string>;
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
// environment does (no NODE_OPTIONS, GIT_*, proxies or tokens).
function engineEnvironment(dataDir: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { [DATA_DIR_ENV]: dataDir };
  const keep =
    process.platform === 'win32'
      ? ['SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP']
      : ['HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME'];
  for (const k of keep) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (process.platform !== 'win32') env['PATH'] = '/usr/bin:/bin';
  return { ...env, ...extra };
}

function startEngine(dataDir: string, launch: EngineLaunch): void {
  // --disable-sigusr1: otherwise any same-user process can open an inspector
  // in the Engine with SIGUSR1 (desktop-auth spike C1, E4).
  const child = spawn(launch.nodePath, ['--disable-sigusr1', launch.engineEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: engineEnvironment(dataDir, launch.env ?? {}),
  });
  child.on('error', () => undefined);
  child.unref();
}
