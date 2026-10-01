// Stand-in Engine: listens on a Unix socket and, for each connection, asks
// the kernel who the peer is and whether it satisfies each requirement.
// Runs on the bundled companion Node, as the real Engine would.
//
//   node src/server.ts <socket> <addon> <requirements.json>
//
// Protocol (spike only, one JSON object per line):
//   plain      client hello -> server checks the peer -> server reply
//   handshake  client hello -> server pins the peer's audit token (T0) and
//              checks it -> server sends a nonce -> client echoes it -> the
//              server accepts only if the echo came from the same process
//              instance (same pid and pidversion as T0)
// Every verdict is also printed on stdout for the harness.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { CodeCheck, Peer, PeerInfo } from './peer.ts';

const [socketPath, addonPath, reqFile] = process.argv.slice(2);
if (!socketPath || !addonPath || !reqFile) throw new Error('usage: server.ts <socket> <addon> <requirements.json>');
const peer = createRequire(import.meta.url)(addonPath) as Peer;
const requirements = JSON.parse(readFileSync(reqFile, 'utf8')) as Record<string, string>;
const HANDSHAKE_REQUIREMENT = requirements['pinned'] ?? '';
const ECHO_TIMEOUT_MS = 1500;

type Hello = { label: string; pid: number; delayMs?: number; handshake?: boolean };

function fdOf(sock: Socket): number {
  const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) throw new Error('no fd on socket');
  return fd;
}

function emit(v: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ event: 'verdict', ...v }) + '\n');
}

const sameInstance = (a: PeerInfo, b: PeerInfo) => a.pid === b.pid && a.pidversion === b.pidversion;

function plain(sock: Socket, fd: number, hello: Hello): void {
  const atRead = peer.peerInfo(fd);
  // Spike only: a client may ask for a pause between reading its request and
  // checking it, standing in for ordinary scheduling latency.
  setTimeout(() => {
    const byToken: Record<string, CodeCheck> = {};
    const byPid: Record<string, CodeCheck> = {};
    for (const [name, req] of Object.entries(requirements)) {
      byToken[name] = peer.checkByToken(fd, req);
      byPid[name] = peer.checkByPid(fd, req);
    }
    emit({ mode: 'plain', label: hello.label, claimedPid: hello.pid, atRead, peer: peer.peerInfo(fd), byToken, byPid });
    sock.end(JSON.stringify({ ok: true, label: hello.label }) + '\n');
  }, Math.min(hello.delayMs ?? 0, 2000));
}

function handshake(sock: Socket, fd: number, hello: Hello, lines: AsyncIterator<string>): void {
  setTimeout(async () => {
    const t0 = peer.peerInfo(fd);
    const t0Check = peer.checkByToken(fd, HANDSHAKE_REQUIREMENT);
    const done = (accepted: boolean, reason: string, t1: PeerInfo | null) => {
      emit({ mode: 'handshake', label: hello.label, claimedPid: hello.pid, t0, t0Check, t1, accepted, reason });
      sock.end(JSON.stringify({ accepted, reason }) + '\n');
    };
    if (!t0Check.valid) return done(false, 'peer does not satisfy the requirement', null);
    const nonce = randomBytes(16).toString('hex');
    sock.write(JSON.stringify({ nonce }) + '\n');
    const next = await Promise.race([lines.next(), new Promise<null>((r) => setTimeout(() => r(null), ECHO_TIMEOUT_MS))]);
    if (!next || next.done) return done(false, 'no echo', null);
    const t1 = peer.peerInfo(fd); // the last sender is whoever wrote the echo
    const echo = JSON.parse(next.value) as { echo?: string };
    if (echo.echo !== nonce) return done(false, 'wrong nonce', t1);
    if (!sameInstance(t0, t1)) return done(false, 'echo came from a different process instance', t1);
    return done(true, 'ok', t1);
  }, Math.min(hello.delayMs ?? 0, 2000));
}

async function* readLines(sock: Socket): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of sock) {
    buf += (chunk as Buffer).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
}

rmSync(socketPath, { force: true });
const server = createServer(async (sock) => {
  sock.on('error', () => undefined);
  const lines = readLines(sock);
  const first = await lines.next();
  if (first.done) return;
  const hello = JSON.parse(first.value) as Hello;
  const fd = fdOf(sock);
  if (hello.handshake) handshake(sock, fd, hello, lines);
  else plain(sock, fd, hello);
});
server.listen(socketPath, () => process.stdout.write(JSON.stringify({ event: 'ready', pid: process.pid, node: process.version, execPath: process.execPath }) + '\n'));
process.on('SIGTERM', () => {
  server.close();
  rmSync(socketPath, { force: true });
  process.exit(0);
});
