// engine-client: connect to the running Engine, or start one on demand with
// the bundled Node, then handshake. Never opens SQLite or runs Git itself.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DtError, type ErrorCode } from '../shared/errors.ts';
import { resolveDataDir, runtimePaths } from './paths.ts';
import { PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, readFrames, writeFrame, type ClientKind, type Response } from './protocol.ts';

export interface ConnectOptions {
  client: ClientKind;
  dataDir?: string;
  autoStart?: boolean;
  // Absolute path of the bundled Node that runs the Engine. Defaults to this
  // process's Node, which is wrong inside Electron, so desktop must pass it.
  nodePath?: string;
  engineEntry?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  protocolVersion?: number;
}

export interface EngineConnection {
  instanceId: string;
  capabilities: string[];
  call<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<T>;
  onEvent(fn: (e: Record<string, unknown>) => void): void;
  close(): void;
  spawnedEngine: boolean;
}

function defaultEngineEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'engine.mjs'), join(here, 'server.ts'), join(here, 'engine', 'server.ts')]) if (existsSync(c)) return c;
  throw new DtError('LOCKED', 'engine entry not found next to the client');
}

function readDiscovery(file: string): { socket: string; token: string; instanceId: string; protocolVersion: number } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { socket: string; token: string; instanceId: string; protocolVersion: number };
  } catch {
    return null;
  }
}

function open(socketPath: string): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = connect(socketPath);
    s.once('connect', () => res(s));
    s.once('error', rej);
  });
}

async function handshake(sock: Socket, client: ClientKind, token: string, protocolVersion: number): Promise<EngineConnection> {
  const waiting = new Map<string, (r: Response) => void>();
  const listeners: ((e: Record<string, unknown>) => void)[] = [];
  readFrames(sock, (m) => {
    const msg = m as Response & { event?: string };
    if (msg.event) listeners.forEach((l) => l(msg as unknown as Record<string, unknown>));
    else waiting.get(msg.requestId)?.(msg);
  });
  sock.on('close', () => {
    for (const [id, fn] of waiting) fn({ requestId: id, ok: false, error: { code: 'LOCKED', message: 'engine connection closed', details: {}, retryable: true } });
    waiting.clear();
  });
  const send = (op: string, extra: Record<string, unknown>): Promise<Response> =>
    new Promise((res) => {
      const requestId = randomUUID();
      waiting.set(requestId, (r) => {
        waiting.delete(requestId);
        res(r);
      });
      writeFrame(sock, { op, requestId, ...extra });
    });
  const hello = await send('hello', { protocolVersion, storageSchemaVersion: STORAGE_SCHEMA_VERSION, client, token });
  if (!hello.ok) {
    sock.destroy();
    throw new DtError((hello.error?.code ?? 'UNAUTHENTICATED') as ErrorCode, hello.error?.message ?? 'handshake failed', hello.error?.details ?? {});
  }
  const info = hello.data as { instanceId: string; capabilities: string[] };
  return {
    instanceId: info.instanceId,
    capabilities: info.capabilities,
    spawnedEngine: false,
    async call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
      const r = await send(op, { payload });
      if (!r.ok) throw new DtError((r.error?.code ?? 'STORAGE_IO_FAILED') as ErrorCode, r.error?.message ?? 'engine error', r.error?.details ?? {}, r.error?.retryable ?? false);
      return r.data as T;
    },
    onEvent: (fn) => listeners.push(fn),
    close: () => sock.end(),
  };
}

// Only these reach the Engine from a client's environment.
function passThroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['DRAFT_TIDE_GIT_ROOT', 'DRAFT_TIDE_ENGINE_IDLE_MS', 'M0_CAPTURE_MODE']) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

async function tryConnect(dataDir: string, opts: ConnectOptions): Promise<EngineConnection | null> {
  const paths = runtimePaths(dataDir);
  const d = readDiscovery(paths.discovery);
  if (!d) return null;
  let sock: Socket;
  try {
    sock = await open(d.socket);
  } catch {
    return null; // stale discovery; the next Engine will replace it
  }
  const token = opts.client === 'desktop' ? readFileSync(paths.desktopToken, 'utf8') : d.token;
  const conn = await handshake(sock, opts.client, token, opts.protocolVersion ?? PROTOCOL_VERSION);
  if (conn.instanceId !== d.instanceId) {
    conn.close();
    return null;
  }
  return conn;
}

export async function connectEngine(opts: ConnectOptions): Promise<EngineConnection> {
  const dataDir = resolveDataDir(opts.dataDir);
  const existing = await tryConnect(dataDir, opts);
  if (existing) return existing;
  if (opts.autoStart === false) throw new DtError('LOCKED', 'Draft Tide engine is not running');

  // Start on demand. Several clients may race here: each may spawn an
  // Engine, but only one wins the lock; the others exit immediately.
  const child = spawn(opts.nodePath ?? process.execPath, [opts.engineEntry ?? defaultEngineEntry()], {
    detached: true,
    stdio: 'ignore',
    env: { ...passThroughEnv(), ...(opts.env ?? {}), DRAFT_TIDE_DATA_DIR: dataDir, PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
  });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      const c = await tryConnect(dataDir, opts);
      if (c) {
        c.spawnedEngine = true;
        return c;
      }
    } catch (e) {
      if (e instanceof DtError && (e.code === 'PROTOCOL_MISMATCH' || e.code === 'UNAUTHENTICATED')) throw e;
      lastErr = e;
    }
  }
  throw new DtError('LOCKED', 'Draft Tide engine did not start in time', { lastError: lastErr instanceof Error ? lastErr.message : null }, true);
}
