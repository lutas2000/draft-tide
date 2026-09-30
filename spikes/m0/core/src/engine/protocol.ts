// Length-framed JSON over a Unix domain socket (named pipe on Windows):
// 4-byte big-endian length + UTF-8 JSON. No HTTP.
import type { Socket } from 'node:net';
import { DtError } from '../shared/errors.ts';

export const PROTOCOL_VERSION = 1;
export const STORAGE_SCHEMA_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

export type ClientKind = 'cli' | 'mcp' | 'desktop' | 'harness';

export interface Hello {
  op: 'hello';
  requestId: string;
  protocolVersion: number;
  storageSchemaVersion: number;
  client: ClientKind;
  token: string;
}

export interface Request {
  op: string;
  requestId: string;
  payload?: unknown;
}

export interface Response {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details: Record<string, unknown>; retryable: boolean };
}

export function writeFrame(sock: Socket, msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new DtError('RESOURCE_BUDGET_EXCEEDED', 'control message too large', { budget: 'control-message' });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  sock.write(Buffer.concat([head, body]));
}

// Calls onMessage per complete frame; destroys the socket on oversize frames.
export function readFrames(sock: Socket, onMessage: (msg: unknown) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        sock.destroy(new Error('frame too large'));
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        sock.destroy(new Error('invalid frame'));
        return;
      }
      onMessage(msg);
    }
  });
}
