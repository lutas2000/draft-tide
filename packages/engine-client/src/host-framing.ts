import { PREVIEW_HOST_MAX_BODY_BYTES, PREVIEW_HOST_MAX_HEADER_BYTES } from '@draft-tide/contracts';
import { FrameError } from './framing.ts';

// Frames of the Engine ↔ Preview Host pipe (contracts preview-host.ts): a
// 4-byte header length, a 4-byte body length, the header as UTF-8 JSON, then
// the body's raw bytes. Shared by the Engine and the Preview Host.

export interface HostFrame {
  header: unknown;
  body: Buffer;
}

export function encodeHostFrame(header: unknown, body: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  if (head.length > PREVIEW_HOST_MAX_HEADER_BYTES) throw new FrameError('preview host header too large');
  if (body.byteLength > PREVIEW_HOST_MAX_BODY_BYTES) throw new FrameError('preview host body too large');
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(head.length, 0);
  lengths.writeUInt32BE(body.byteLength, 4);
  return Buffer.concat([lengths, head, body]);
}

// Feed it pipe chunks; it returns every complete frame. Chunks are kept as a
// list and joined once per frame, so a large body arriving in many small
// chunks is copied once. Throws FrameError on a size over the limits or a
// header that isn't UTF-8 JSON, after which the pipe must close.
export class HostFrameDecoder {
  #chunks: Buffer[] = [];
  #length = 0;
  #need: { header: number; body: number } | null = null;

  push(chunk: Buffer): HostFrame[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
    }
    const out: HostFrame[] = [];
    for (;;) {
      if (!this.#need) {
        if (this.#length < 8) break;
        const lengths = this.#take(8);
        const header = lengths.readUInt32BE(0);
        const body = lengths.readUInt32BE(4);
        if (header > PREVIEW_HOST_MAX_HEADER_BYTES || body > PREVIEW_HOST_MAX_BODY_BYTES) {
          throw new FrameError(`preview host frame of ${header}+${body} bytes exceeds the limits`);
        }
        this.#need = { header, body };
      }
      const need = this.#need;
      if (this.#length < need.header + need.body) break;
      const headBytes = this.#take(need.header);
      const body = this.#take(need.body);
      this.#need = null;
      let header: unknown;
      try {
        header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headBytes));
      } catch {
        throw new FrameError('preview host header is not UTF-8 JSON');
      }
      out.push({ header, body });
    }
    return out;
  }

  // The first n buffered bytes, removed from the buffer.
  #take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.#chunks[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
      this.#length -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.#chunks[0];
      if (!c) throw new FrameError('internal: buffered length out of sync');
      const take = Math.min(c.length, n - at);
      c.copy(out, at, 0, take);
      at += take;
      if (take === c.length) this.#chunks.shift();
      else this.#chunks[0] = c.subarray(take);
    }
    this.#length -= n;
    return out;
  }
}
