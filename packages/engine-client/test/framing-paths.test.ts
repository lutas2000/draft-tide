import fc from 'fast-check';
import { MAX_FRAME_BYTES, PREVIEW_HOST_MAX_BODY_BYTES, PREVIEW_HOST_MAX_HEADER_BYTES } from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  FrameError,
  HostFrameDecoder,
  encodeFrame,
  encodeHostFrame,
  desktopProfileDir,
  runtimePaths,
} from '../src/index.ts';

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

  it("keeps the app's Chromium profile in a subfolder of the data directory", () => {
    expect(desktopProfileDir('/Users/a/Library/Application Support/Draft Tide', 'darwin')).toBe(
      '/Users/a/Library/Application Support/Draft Tide/desktop',
    );
    expect(desktopProfileDir('C:\\Users\\a\\AppData\\Roaming\\Draft Tide', 'win32')).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\Draft Tide\\desktop',
    );
  });
});

describe('Preview Host frames', () => {
  it('decode any split of headers and bodies', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.jsonValue(), fc.uint8Array({ maxLength: 300 })), { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (frames, cuts) => {
          const bytes = Buffer.concat(frames.map(([h, b]) => encodeHostFrame(h, b)));
          const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
          const decoder = new HostFrameDecoder();
          const out: { header: unknown; body: Buffer }[] = [];
          let prev = 0;
          for (const p of [...points, bytes.length]) {
            out.push(...decoder.push(bytes.subarray(prev, p)));
            prev = p;
          }
          expect(out.map((f) => [f.header, [...f.body]])).toEqual(
            frames.map(([h, b]) => [JSON.parse(JSON.stringify(h)) as unknown, [...b]]),
          );
        },
      ),
    );
  });

  it('joins a large body arriving in small chunks once', () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 3);
    const bytes = encodeHostFrame({ type: 'image' }, body);
    const decoder = new HostFrameDecoder();
    const out = [];
    for (let at = 0; at < bytes.length; at += 64 * 1024) out.push(...decoder.push(bytes.subarray(at, at + 64 * 1024)));
    expect(out).toHaveLength(1);
    expect(out[0]?.body.equals(body)).toBe(true);
  });

  it('refuses sizes over the limits before buffering, and headers that are not JSON', () => {
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(PREVIEW_HOST_MAX_HEADER_BYTES + 1, 0);
    expect(() => new HostFrameDecoder().push(lengths)).toThrow(FrameError);
    lengths.writeUInt32BE(10, 0);
    lengths.writeUInt32BE(PREVIEW_HOST_MAX_BODY_BYTES + 1, 4);
    expect(() => new HostFrameDecoder().push(lengths)).toThrow(FrameError);
    const bad = Buffer.alloc(10);
    bad.writeUInt32BE(2, 0);
    bad.write('{x', 8);
    expect(() => new HostFrameDecoder().push(bad)).toThrow(FrameError);
    expect(() => encodeHostFrame({}, Buffer.alloc(PREVIEW_HOST_MAX_BODY_BYTES + 1))).toThrow(FrameError);
  });
});
