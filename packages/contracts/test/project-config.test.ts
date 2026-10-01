import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  ProjectId,
  isSafeRelativePath,
  isSingleLine,
  parseProjectConfig,
  serializeProjectConfig,
  type ProjectConfig,
} from '../src/index.ts';

const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: randomUUID(),
    name: 'Aurora 定價頁',
    entryFiles: ['index.html', 'pages/關於 我們.html'],
    excludeDirNames: ['node_modules', '.cache'],
    excludeFilePatterns: ['*.log', '.env.*'],
    ...overrides,
  };
}

function rejection(bytes: Uint8Array): DtError {
  try {
    parseProjectConfig(bytes);
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected CONFIG_INVALID');
}

describe('parseProjectConfig', () => {
  it('accepts a valid file', () => {
    const cfg = valid();
    expect(parseProjectConfig(enc(cfg))).toEqual(cfg);
  });

  it.each([
    ['an unknown field', valid({ run: 'rm -rf /' })],
    ['a missing field', (({ name: _n, ...rest }) => rest)(valid())],
    ['an absolute entry', valid({ entryFiles: ['/etc/passwd'] })],
    ['a drive-letter entry', valid({ entryFiles: ['C:/x.html'] })],
    ['a parent-escaping entry', valid({ entryFiles: ['pages/../../x.html'] })],
    ['an entry inside .git', valid({ entryFiles: ['.GIT/config'] })],
    ['a backslash entry', valid({ entryFiles: ['pages\\x.html'] })],
    ['an empty segment', valid({ entryFiles: ['pages//x.html'] })],
    ['an exclude name with a slash', valid({ excludeDirNames: ['a/b'] })],
    ['an exclude name of .git', valid({ excludeDirNames: ['.git'] })],
    ['a negated pattern', valid({ excludeFilePatterns: ['!keep.txt'] })],
    ['too many entries', valid({ entryFiles: Array.from({ length: 17 }, (_, i) => `p${i}.html`) })],
    ['a multi-line name', valid({ name: 'a\nb' })],
    ['an uppercase project id', valid({ projectId: randomUUID().toUpperCase() })],
    ['schemaVersion 0', valid({ schemaVersion: 0 })],
    ['a JSON array', []],
  ])('rejects %s', (_label, raw) => {
    const err = rejection(enc(raw));
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('rejects non-UTF-8 bytes and non-JSON', () => {
    expect(rejection(new Uint8Array([0x7b, 0xff, 0x7d])).details['reason']).toBe('not-json');
    expect(rejection(enc('{"schemaVersion":')).details['reason']).toBe('not-json');
  });

  it('rejects files over 64 KiB before parsing', () => {
    const big = new Uint8Array(MAX_PROJECT_CONFIG_BYTES + 1).fill(0x20);
    expect(rejection(big).details['reason']).toBe('too-large');
  });

  it('says when a newer Draft Tide wrote the file', () => {
    const err = rejection(enc(valid({ schemaVersion: 2, viewports: [] })));
    expect(err.details).toMatchObject({ reason: 'newer-schema', requiresNewerApp: true, schemaVersion: 2 });
  });

  it('round-trips through its own formatting', () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/)
      .filter((s) => s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
    const relPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
    const config = fc.record({
      schemaVersion: fc.constant(1 as const),
      projectId: fc.uuid({ version: 4 }).map((u) => ProjectId.parse(u)),
      name: fc.string({ maxLength: 40 }).filter(isSingleLine),
      entryFiles: fc.array(relPath, { maxLength: 16 }),
      excludeDirNames: fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/), { maxLength: 8 }),
      excludeFilePatterns: fc.array(fc.stringMatching(/^[A-Za-z0-9*?._-]{1,20}$/), { maxLength: 8 }),
    });
    fc.assert(
      fc.property(config, (cfg: ProjectConfig) => {
        expect(parseProjectConfig(enc(serializeProjectConfig(cfg)))).toEqual(cfg);
      }),
    );
  });
});

describe('isSafeRelativePath', () => {
  it('never accepts a path with a .. segment', () => {
    const seg = fc.oneof(fc.constant('..'), fc.stringMatching(/^[a-z]{1,5}$/));
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 6 }), (segs) => {
        const p = segs.join('/');
        if (segs.includes('..')) expect(isSafeRelativePath(p)).toBe(false);
        else expect(isSafeRelativePath(p)).toBe(true);
      }),
    );
  });

  it('accepts CJK, spaces and emoji', () => {
    expect(isSafeRelativePath('設計/首頁 v2 🎨.html')).toBe(true);
  });
});
