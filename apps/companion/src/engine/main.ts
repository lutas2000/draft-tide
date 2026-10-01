// The Engine: the only process that writes design data or SQLite. Started on
// demand by any client (GUI, CLI, MCP); exits when idle.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EngineInstanceId, PROTOCOL_VERSION, type Discovery, type EngineEvent } from '@draft-tide/contracts';
import { createEngineCore } from '@draft-tide/core';
import { resolveDataDir, runtimePaths } from '@draft-tide/engine-client';
import { openLocalStore, tryAcquireEngineLock } from '@draft-tide/local-store';
import { BUILD } from '../build-info.ts';
import { createPeerVerifier } from './peer-identity.ts';
import { createEngineServer, type EngineServer } from './server.ts';

process.umask(0o077);
const instanceId = EngineInstanceId.parse(randomUUID());
const dataDir = resolveDataDir();
const paths = runtimePaths(dataDir);
const IDLE_MS = Math.max(200, Number(process.env['DRAFT_TIDE_ENGINE_IDLE_MS'] ?? 30_000) || 30_000);

// Diagnostics hold no design content, tokens or secrets.
mkdirSync(join(dataDir, 'diagnostics'), { recursive: true, mode: 0o700 });
const logFile = join(dataDir, 'diagnostics', 'engine.log');
function log(msg: string): void {
  const line = `${new Date().toISOString()} [engine ${process.pid} ${instanceId.slice(0, 8)}] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // Logging must never stop the Engine.
  }
}

// The runtime directory holds the socket and the discovery file with the tool
// token: a real directory, owned by us, 0700.
mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  chmodSync(paths.runtimeDir, 0o700);
  const st = lstatSync(paths.runtimeDir);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) {
    log(`runtime directory ${paths.runtimeDir} is not a private directory; refusing to start`);
    process.exit(2);
  }
}

// One Engine per data store. Losing the race is normal: exit quietly.
const lock = tryAcquireEngineLock(paths.lockFile);
if (!lock) process.exit(0);

let store: Awaited<ReturnType<typeof openLocalStore>>;
try {
  store = await openLocalStore({ dataDir });
} catch (e) {
  log(`cannot open local state: ${e instanceof Error ? e.message : String(e)}`);
  lock.release();
  process.exit(3);
}

// Crash recovery (M1-05) runs here, before the Engine accepts any request.

const verifier = createPeerVerifier(BUILD.desktopRequirement, log);
const toolToken = randomBytes(32).toString('base64url');
const startedAt = new Date().toISOString();
let server: EngineServer | null = null;
const core = createEngineCore({
  clock: { nowIso: () => new Date().toISOString() },
  store,
  events: { publish: (e: EngineEvent) => server?.publish(e) },
  identity: {
    instanceId,
    appVersion: BUILD.appVersion,
    startedAt,
    desktopIdentity: verifier.mode,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  },
});

let lastActivity = Date.now();
server = createEngineServer({
  core,
  verifier,
  instanceId,
  toolToken,
  log,
  onActivity: () => {
    lastActivity = Date.now();
  },
});

function writePrivateFile(file: string, body: string): void {
  const tmp = `${file}.${instanceId}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
}

// We hold the lock, so a socket file left here belongs to a dead Engine.
if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
server.server.on('error', (e) => {
  log(`listen failed: ${e.message}`);
  shutdown('listen failed', 4);
});
server.server.listen(paths.socket, () => {
  if (process.platform !== 'win32') chmodSync(paths.socket, 0o600);
  const discovery: Discovery = {
    pid: process.pid,
    instanceId,
    protocolVersion: PROTOCOL_VERSION,
    socket: paths.socket,
    toolToken,
    startedAt,
  };
  writePrivateFile(paths.discoveryFile, JSON.stringify(discovery));
  log(
    `ready: ${BUILD.mode} ${BUILD.appVersion}, node ${process.version}, sqlite ${store.sqliteVersion}, desktop identity ${verifier.mode}`,
  );
});

let stopping = false;
function shutdown(reason: string, code = 0): void {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  server?.server.close();
  try {
    const current = JSON.parse(readFileSync(paths.discoveryFile, 'utf8')) as { instanceId?: string };
    if (current.instanceId === instanceId) rmSync(paths.discoveryFile, { force: true });
  } catch {
    // Already gone.
  }
  if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
  store.close();
  lock?.release();
  process.exit(code);
}

setInterval(
  () => {
    if (server && server.sessionCount() === 0 && server.inFlight() === 0 && Date.now() - lastActivity > IDLE_MS)
      shutdown('idle');
  },
  Math.min(1000, IDLE_MS),
).unref();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  log(`uncaught: ${e.stack ?? e.message}`);
  shutdown('uncaught exception', 1);
});
