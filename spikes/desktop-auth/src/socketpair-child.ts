// The "Engine" end of the socketpair: fd 3, inherited from Electron main.
import { fstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import type { Peer } from './peer.ts';

const addon = process.argv[2];
if (!addon) throw new Error('usage: socketpair-child.ts <addon>');
const peer = createRequire(import.meta.url)(addon) as Peer;
const isSocket = fstatSync(3).isSocket();
const info = peer.peerInfo(3);
const identity = peer.checkByToken(3, 'identifier "Electron"');
const s = new Socket({ fd: 3, readable: true, writable: true });
let buf = '';
s.on('data', (d: Buffer) => {
  buf += d.toString('utf8');
  if (!buf.includes('\n')) return;
  const hello = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as unknown;
  s.end(JSON.stringify({ isSocket, peer: info, identity, hello }) + '\n', () => process.exit(0));
});
