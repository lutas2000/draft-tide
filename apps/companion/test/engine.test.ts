import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DtError, type EngineEvent } from '@draft-tide/contracts';
import { runtimePaths } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNative } from '../scripts/build.ts';
import { RawClient, cleanupDataDirs, connectTo, hello, readDiscovery, tempDataDir } from './helpers.ts';

afterAll(cleanupDataDirs);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof DtError) return e.code;
    throw e;
  }
}

describe('Engine lifecycle', () => {
  it('starts on demand and keeps its runtime files private', async () => {
    const dataDir = tempDataDir();
    const conn = await connectTo(dataDir, 'cli');
    const info = await conn.call('engine.info', {});
    expect(info).toMatchObject({ channel: 'cli', protocolVersion: 1, agentAccess: { enabled: false } });
    conn.close();
    if (process.platform !== 'win32') {
      const paths = runtimePaths(dataDir);
      expect(statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.discoveryFile).mode & 0o777).toBe(0o600);
      expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    }
  });

  it('settles racing cold starts on one Engine', async () => {
    const dataDir = tempDataDir();
    const conns = await Promise.all(Array.from({ length: 8 }, () => connectTo(dataDir, 'cli')));
    expect(new Set(conns.map((c) => c.instanceId)).size).toBe(1);
    expect(readDiscovery(dataDir)?.instanceId).toBe(conns[0]?.instanceId);
    for (const c of conns) c.close();
  });

  it('is replaced after being killed, without pid guessing', async () => {
    const dataDir = tempDataDir();
    const first = await connectTo(dataDir, 'cli');
    const pid = readDiscovery(dataDir)?.pid ?? 0;
    process.kill(pid, 'SIGKILL');
    await new Promise<void>((r) => first.onClose(r));
    const second = await connectTo(dataDir, 'cli');
    expect(second.instanceId).not.toBe(first.instanceId);
    second.close();
  });

  it('exits when idle and cleans up its discovery file', async () => {
    const dataDir = tempDataDir();
    const conn = await connectTo(dataDir, 'cli', 300);
    conn.close();
    const deadline = Date.now() + 5_000;
    while (readDiscovery(dataDir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(readDiscovery(dataDir)).toBeNull();
  });
});

describe('agent access across channels', () => {
  it('is switched only by the desktop, and takes effect at once', async () => {
    const dataDir = tempDataDir();
    const desktop = await connectTo(dataDir, 'desktop');
    const cli = await connectTo(dataDir, 'cli');
    const mcp = await connectTo(dataDir, 'mcp');
    const events: EngineEvent[] = [];
    desktop.onEvent((e) => events.push(e));

    expect(await codeOf(cli.call('project.list', {}))).toBe('AGENT_ACCESS_DISABLED');
    expect(await codeOf(mcp.callRaw('agentAccess.set', { enabled: true, confirmed: true }))).toBe('UNKNOWN_OPERATION');

    await desktop.call('agentAccess.set', { enabled: true });
    expect(await cli.call('project.list', {})).toEqual([]);
    expect(await mcp.call('project.list', {})).toEqual([]);

    await desktop.call('agentAccess.set', { enabled: false });
    expect(await codeOf(mcp.call('project.list', {}))).toBe('AGENT_ACCESS_DISABLED');
    expect(await codeOf(cli.call('engine.info', {}))).toBe('ok');

    await new Promise((r) => setTimeout(r, 50));
    expect(events.map((e) => e.name === 'agentAccess.changed' && e.agentAccess.enabled)).toEqual([true, false]);
    for (const c of [desktop, cli, mcp]) c.close();
  });

  it('survives an Engine restart (the switch lives in SQLite)', async () => {
    const dataDir = tempDataDir();
    const desktop = await connectTo(dataDir, 'desktop');
    await desktop.call('agentAccess.set', { enabled: true });
    process.kill(readDiscovery(dataDir)?.pid ?? 0, 'SIGKILL');
    await new Promise<void>((r) => desktop.onClose(r));
    const cli = await connectTo(dataDir, 'cli');
    expect(await cli.call('project.list', {})).toEqual([]);
    cli.close();
  });
});

describe('handshake', () => {
  it('refuses a wrong tool token, a missing token and a protocol mismatch', async () => {
    const dataDir = tempDataDir();
    (await connectTo(dataDir, 'cli')).close();
    const socket = readDiscovery(dataDir)?.socket ?? '';

    for (const [msg, code] of [
      [hello('cli', { toolToken: 'x'.repeat(43) }), 'UNAUTHENTICATED'],
      [hello('mcp'), 'UNAUTHENTICATED'],
      [hello('cli', { protocolVersion: 99, toolToken: readDiscovery(dataDir)?.toolToken }), 'PROTOCOL_MISMATCH'],
      [{ type: 'request', requestId: crypto.randomUUID(), op: 'engine.info', payload: {} }, 'UNAUTHENTICATED'],
    ] as const) {
      const raw = await RawClient.open(socket);
      raw.send(msg);
      const reply = await raw.next();
      expect(reply['type']).toBe('rejected');
      expect((reply['error'] as { code: string }).code).toBe(code);
      expect((await raw.next())['type']).toBe('closed');
    }
  });

  it('does not let the tool channel claim desktop powers with a token', async () => {
    const dataDir = tempDataDir();
    (await connectTo(dataDir, 'cli')).close();
    const d = readDiscovery(dataDir);
    const raw = await RawClient.open(d?.socket ?? '');
    raw.send(hello('cli', { toolToken: d?.toolToken }));
    expect((await raw.next())['type']).toBe('welcome');
    raw.send({ type: 'request', requestId: crypto.randomUUID(), op: 'agentAccess.set', payload: { enabled: true } });
    const reply = await raw.next();
    expect(reply).toMatchObject({ type: 'response', ok: false, error: { code: 'UNKNOWN_OPERATION' } });
    raw.socket.end();
  });
});

// Hands the socket to another process, which sends `frame` and reports what
// the Engine answers. On macOS the kernel then reports that process as the
// peer, which is exactly what the instance pinning must catch.
function sendFromOtherProcess(raw: RawClient, frame: unknown): Promise<Record<string, unknown>> {
  const code = `
    process.on('message', (msg, sock) => {
      const body = Buffer.from(JSON.stringify(msg.frame));
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          const n = buf.readUInt32BE(0);
          process.send(JSON.parse(buf.subarray(4, 4 + n).toString()));
          buf = buf.subarray(4 + n);
        }
      });
      sock.on('close', () => { process.send({ type: 'closed' }); setTimeout(() => process.exit(0), 50); });
      sock.write(Buffer.concat([head, body]));
    });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('child got no answer'));
    }, 5_000);
    child.once('message', (m) => {
      clearTimeout(timer);
      resolve(m as Record<string, unknown>);
      setTimeout(() => child.kill(), 200);
    });
    child.send({ frame }, raw.socket);
  });
}

describe.runIf(process.platform === 'darwin')('desktop instance pinning (macOS)', () => {
  let socketPath = '';

  beforeAll(async () => {
    buildNative();
    const dataDir = tempDataDir();
    (await connectTo(dataDir, 'cli', 10_000)).close();
    socketPath = readDiscovery(dataDir)?.socket ?? '';
    // Control: without the addon these checks would pass vacuously.
    expect(readFileSync(join(dataDir, 'diagnostics', 'engine.log'), 'utf8')).toContain('instance pinning on');
  });

  async function startDesktopHandshake(): Promise<{ raw: RawClient; nonce: string }> {
    const raw = await RawClient.open(socketPath);
    raw.send(hello('desktop'));
    const challenge = await raw.next();
    expect(challenge['type']).toBe('challenge');
    return { raw, nonce: String(challenge['nonce']) };
  }

  it('accepts the echo from the process that said hello', async () => {
    const { raw, nonce } = await startDesktopHandshake();
    raw.send({ type: 'challenge-response', nonce });
    expect((await raw.next())['type']).toBe('welcome');
    raw.socket.end();
  });

  it('refuses a wrong nonce', async () => {
    const { raw } = await startDesktopHandshake();
    raw.send({ type: 'challenge-response', nonce: '0'.repeat(64) });
    expect(await raw.next()).toMatchObject({ type: 'rejected', error: { code: 'UNAUTHENTICATED' } });
  });

  it('refuses an echo sent by another process (spike A10)', async () => {
    const { raw, nonce } = await startDesktopHandshake();
    const answer = await sendFromOtherProcess(raw, { type: 'challenge-response', nonce });
    expect(answer).toMatchObject({ type: 'rejected', error: { code: 'UNAUTHENTICATED' } });
  });

  it('closes a verified session when another process writes to it', async () => {
    const { raw, nonce } = await startDesktopHandshake();
    raw.send({ type: 'challenge-response', nonce });
    expect((await raw.next())['type']).toBe('welcome');
    const answer = await sendFromOtherProcess(raw, {
      type: 'request',
      requestId: crypto.randomUUID(),
      op: 'agentAccess.set',
      payload: { enabled: true },
    });
    expect(answer).toMatchObject({ type: 'rejected', error: { code: 'UNAUTHENTICATED' } });
  });
});
