import { DtError, MAX_FRAME_BYTES } from '@draft-tide/contracts';

// 4-byte big-endian length, then that many bytes of UTF-8 JSON. Shared by the
// Engine and every client.
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new DtError('RESOURCE_BUDGET_EXCEEDED', 'control message too large', { budget: 'control-message' });
  }
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameError extends Error {}

// Feed it socket chunks; it returns every complete message. Throws FrameError
// on an oversized frame or bad JSON, after which the connection must close.
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new FrameError(`frame of ${len} bytes exceeds the limit`);
      if (this.#buffer.length < 4 + len) break;
      const body = this.#buffer.subarray(4, 4 + len);
      this.#buffer = this.#buffer.subarray(4 + len);
      try {
        out.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
      } catch {
        throw new FrameError('frame is not UTF-8 JSON');
      }
    }
    return out;
  }
}
