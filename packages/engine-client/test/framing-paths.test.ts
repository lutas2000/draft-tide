import fc from 'fast-check';
import { MAX_FRAME_BYTES } from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, FrameError, encodeFrame, runtimePaths } from '../src/index.ts';

describe('framing', () => {
  it('decodes any split of any sequence of messages', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (messages, cuts) => {
          const bytes = Buffer.concat(messages.map((m) => encodeFrame(m)));
          const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
          const decoder = new FrameDecoder();
          const out: unknown[] = [];
          let prev = 0;
          for (const p of [...points, bytes.length]) {
            out.push(...decoder.push(bytes.subarray(prev, p)));
            prev = p;
          }
          expect(out).toEqual(messages.map((m) => JSON.parse(JSON.stringify(m)) as unknown));
        },
      ),
    );
  });

  it('refuses an oversized frame before buffering it', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(head)).toThrow(FrameError);
    expect(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES))).toThrow(/too large/);
  });

  it('refuses a body that is not UTF-8 JSON', () => {
    const body = Buffer.from([0xff, 0xfe]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    expect(() => new FrameDecoder().push(Buffer.concat([head, body]))).toThrow(FrameError);
  });
});

describe('runtimePaths', () => {
  it('keeps a short data dir socket inside the runtime directory', () => {
    const p = runtimePaths('/tmp/dt', 'darwin');
    expect(p.socket).toBe('/tmp/dt/runtime/engine.sock');
    expect(p.discoveryFile).toBe('/tmp/dt/runtime/engine.json');
  });

  it('moves a socket that would overflow sun_path', () => {
    const p = runtimePaths(`/tmp/${'x'.repeat(120)}`, 'darwin');
    expect(Buffer.byteLength(p.socket)).toBeLessThan(104);
    expect(p.socket).toMatch(/draft-tide-[0-9a-f]{24}\.sock$/);
  });

  it('uses a per-data-store named pipe on Windows', () => {
    expect(runtimePaths('C:\\Users\\a\\dt', 'win32').socket).toMatch(/^\\\\\.\\pipe\\draft-tide-[0-9a-f]{24}$/);
  });
});
