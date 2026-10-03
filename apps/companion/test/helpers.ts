import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Discovery, type Channel } from '@draft-tide/contracts';
import {
  FrameDecoder,
  connectEngine,
  encodeFrame,
  runtimePaths,
  scriptEngineLaunch,
  type EngineConnection,
} from '@draft-tide/engine-client';
import { findGitOnPath } from '@draft-tide/git-backend';
import { tryAcquireEngineLock } from '@draft-tide/local-store';

export const COMPANION = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_SOURCE = join(COMPANION, 'src', 'engine', 'main.ts');
export const CLI_SOURCE = join(COMPANION, 'src', 'cli', 'main.ts');

// The Engine starts with a minimal environment (no PATH on Windows): it runs
// the Git the tests run, named explicitly. Spawned CLIs pass it on.
const git = findGitOnPath();
if (!git) throw new Error('these tests need git on PATH (or DRAFT_TIDE_GIT)');
process.env['DRAFT_TIDE_GIT'] = git;
export const GIT_FOR_ENGINE = git;

const created: string[] = [];

export function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dt-eng-'));
  created.push(d);
  return d;
}

export function readDiscovery(dataDir: string): Discovery | null {
  try {
    return Discovery.parse(JSON.parse(readFileSync(runtimePaths(dataDir).discoveryFile, 'utf8')));
  } catch {
    return null;
  }
}

export async function stopEngine(dataDir: string): Promise<void> {
  const d = readDiscovery(dataDir);
  if (!d) return;
  try {
    process.kill(d.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(d.pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Every Engine of a data store holds its lock while alive, including one that
// is not (or no longer) named in the discovery file, such as an Engine that is
// mid-shutdown. Taking the lock proves none is left.
async function waitForNoEngine(dataDir: string, timeoutMs = 15_000): Promise<void> {
  const file = runtimePaths(dataDir).lockFile;
  if (!existsSync(file)) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = tryAcquireEngineLock(file);
    if (lock) return lock.release();
    if (Date.now() > deadline) throw new Error(`an Engine for ${dataDir} is still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function cleanupDataDirs(): Promise<void> {
  for (const d of created.splice(0)) {
    await stopEngine(d);
    await waitForNoEngine(d);
    // Windows releases a terminated process's file handles a moment later.
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

// extraEnv reaches an Engine this call starts (a crash point, say).
export function connectTo(
  dataDir: string,
  channel: Channel,
  idleMs = 2_000,
  extraEnv: Record<string, string> = {},
): Promise<EngineConnection> {
  return connectEngine({
    channel,
    dataDir,
    client: { name: 'test', version: '0' },
    launch: scriptEngineLaunch(process.execPath, ENGINE_SOURCE, {
      DRAFT_TIDE_ENGINE_IDLE_MS: String(idleMs),
      DRAFT_TIDE_GIT: GIT_FOR_ENGINE,
      ...extraEnv,
    }),
  });
}

// A hand-driven connection for protocol-level tests.
export class RawClient {
  readonly socket: Socket;
  readonly #decoder = new FrameDecoder();
  readonly #queue: unknown[] = [];
  readonly #waiters: ((m: unknown) => void)[] = [];
  closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const m of this.#decoder.push(chunk)) {
        const w = this.#waiters.shift();
        if (w) w(m);
        else this.#queue.push(m);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const w of this.#waiters.splice(0)) w({ type: 'closed' });
    });
    socket.on('error', () => undefined);
  }

  static open(socketPath: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const s = connect(socketPath);
      s.once('connect', () => resolve(new RawClient(s)));
      s.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.write(encodeFrame(message));
  }

  next(timeoutMs = 3_000): Promise<Record<string, unknown>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as Record<string, unknown>);
    if (this.closed) return Promise.resolve({ type: 'closed' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message in time')), timeoutMs);
      this.#waiters.push((m) => {
        clearTimeout(timer);
        resolve(m as Record<string, unknown>);
      });
    });
  }
}

export const hello = (channel: Channel, extra: Record<string, unknown> = {}) => ({
  type: 'hello',
  protocolVersion: 1,
  channel,
  client: { name: 'raw', version: '0' },
  ...extra,
});
