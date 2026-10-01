import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CommitIdentity,
  DRAFT_TIDE_IDENTITY,
  DtError,
  MAX_SNAPSHOT_METADATA_BYTES,
  SNAPSHOT_KINDS,
  SNAPSHOT_METADATA_KEY,
  SaveProgress,
  canonicalJson,
  formatCommitMessage,
  isSafeRelativePath,
  isSingleLine,
  readCommitMetadata,
  type SnapshotMetadata,
} from '../src/index.ts';

function meta(over: Partial<SnapshotMetadata> = {}): SnapshotMetadata {
  return {
    schemaVersion: 1,
    snapshotId: randomUUID() as SnapshotMetadata['snapshotId'],
    kind: 'manual',
    createdAt: '2026-10-02T08:30:00.123Z',
    origin: 'gui',
    operationId: randomUUID() as NonNullable<SnapshotMetadata['operationId']>,
    ...over,
  };
}

const line = (m: Record<string, unknown>) => `${SNAPSHOT_METADATA_KEY}: ${canonicalJson(m)}`;

describe('commit message metadata', () => {
  it('puts the name on the title line and the metadata on the last line', () => {
    const m = meta({ name: '  Compact pricing cards 定價 🎨  ' });
    const message = formatCommitMessage(m);
    expect(message).toBe(`Compact pricing cards 定價 🎨\n\n${line(m)}\n`);
    expect(readCommitMetadata(message)).toEqual({ status: 'snapshot', metadata: m });
  });

  it('gives each kind a fixed title when there is no name', () => {
    const titles = SNAPSHOT_KINDS.map((kind) => formatCommitMessage(meta({ kind })).split('\n')[0]);
    expect(titles).toEqual([
      'Baseline',
      'Saved version',
      'Saved version (agent request)',
      'Before restore',
      'Restored version',
    ]);
    expect(formatCommitMessage(meta({ name: '   ' })).split('\n')[0]).toBe('Saved version');
  });

  it('round-trips any valid metadata (property)', () => {
    const arb = fc.record({
      kind: fc.constantFrom(...SNAPSHOT_KINDS),
      origin: fc.constantFrom('gui', 'cli', 'mcp' as const),
      name: fc.option(fc.string({ maxLength: 200 }).filter(isSingleLine), { nil: undefined }),
      restore: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, ({ kind, origin, name, restore }) => {
        const m = meta({
          kind,
          origin,
          ...(name !== undefined ? { name } : {}),
          ...(restore ? { restoreOf: randomUUID() as SnapshotMetadata['snapshotId'] } : {}),
        });
        expect(readCommitMetadata(formatCommitMessage(m))).toEqual({ status: 'snapshot', metadata: m });
      }),
    );
  });

  it('refuses metadata outside its contract when writing', () => {
    expect(() => formatCommitMessage({ ...meta(), kind: 'merge' } as unknown as SnapshotMetadata)).toThrow(DtError);
    expect(() => formatCommitMessage(meta({ name: 'a\nb' }))).toThrow(DtError);
  });

  it('treats a message without the line as another tool’s commit', () => {
    expect(readCommitMetadata('Fix typo\n')).toEqual({ status: 'external' });
    expect(readCommitMetadata('')).toEqual({ status: 'external' });
    // The key alone on the title line is the user's text, not metadata.
    const m = meta();
    expect(readCommitMetadata(`${line(m)}\n\nmore text\n`)).toEqual({ status: 'external' });
  });

  it('reads strictly: one spelling, the schema exactly, within the size limit', () => {
    const m = meta();
    const ok = `Saved version\n\n${line(m)}\n`;
    expect(readCommitMetadata(ok).status).toBe('snapshot');
    const json = canonicalJson(m);
    const invalid = { status: 'unreadable', reason: 'invalid' };
    for (const message of [
      // Not separated from the text by a blank line, or alone.
      `Saved version\n${line(m)}\n`,
      `${line(m)}\n`,
      // Not canonical: spaces, key order, a repeated key.
      `T\n\n${SNAPSHOT_METADATA_KEY}: ${JSON.stringify(m, null, 1).replaceAll('\n', '')}\n`,
      `T\n\n${SNAPSHOT_METADATA_KEY}: ${JSON.stringify(Object.fromEntries(Object.entries(m).reverse()))}\n`,
      `T\n\n${SNAPSHOT_METADATA_KEY}: ${json.replace('{', '{"kind":"baseline",')}\n`,
      // Outside the schema.
      `T\n\n${line({ ...m, kind: 'merge' })}\n`,
      `T\n\n${line({ ...m, extra: 1 })}\n`,
      `T\n\n${line({ ...m, snapshotId: m.snapshotId.toUpperCase() })}\n`,
      `T\n\n${line({ ...m, createdAt: '2026-10-02T08:30:00Z' })}\n`,
      `T\n\n${SNAPSHOT_METADATA_KEY}: not json\n`,
      `T\n\n${SNAPSHOT_METADATA_KEY}: null\n`,
      // Too large.
      `T\n\n${line({ ...m, name: 'x'.repeat(MAX_SNAPSHOT_METADATA_BYTES) })}\n`,
    ]) {
      expect(readCommitMetadata(message), message).toEqual(invalid);
    }
    expect(readCommitMetadata(`T\n\n${line({ ...m, schemaVersion: 2, future: true })}\n`)).toEqual({
      status: 'unreadable',
      reason: 'newer-schema',
    });
  });
});

describe('commit identity', () => {
  it('accepts plain names and noreply addresses', () => {
    expect(CommitIdentity.parse(DRAFT_TIDE_IDENTITY)).toEqual(DRAFT_TIDE_IDENTITY);
    for (const id of [
      { name: '王小明', email: '12345+octocat@users.noreply.github.com' },
      { name: 'Ann-Marie O’Neil', email: '1+a@users.noreply.github.com' },
    ]) {
      expect(CommitIdentity.safeParse(id).success, id.name).toBe(true);
    }
  });

  it('refuses what Git would silently rewrite', () => {
    for (const id of [
      { name: '', email: 'a@b' },
      { name: 'Ann <ann@evil>', email: 'a@b' },
      { name: 'Ann\nB', email: 'a@b' },
      { name: ' Ann', email: 'a@b' },
      { name: 'Ann B.', email: 'a@b' },
      { name: '"Ann"', email: 'a@b' },
      { name: 'Ann', email: 'a b@c' },
      { name: 'Ann', email: 'a@b>c' },
      { name: 'Ann', email: 'a@@b' },
      { name: 'Ann', email: 'no-at' },
      { name: 'Ann', email: 'é@b' },
    ]) {
      expect(CommitIdentity.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe('Git-safe paths', () => {
  it('refuses names a filesystem would take for .git', () => {
    for (const p of [
      '.git/config',
      '.GIT/config',
      'a/.Git/x',
      '.g\u200cit/config',
      '.git\u200d/x',
      '\ufeff.git/hooks/x',
      '.git./x',
      '.git /x',
      '.git . ./x',
      '.git::$INDEX_ALLOCATION/x',
      'GIT~1/config',
      'a/git~1/x',
      'git~1. /x',
    ]) {
      expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
    }
  });

  it('keeps names that only look similar', () => {
    for (const p of [
      '.github/workflows/ci.yml',
      '.gitignore',
      '.gitattributes',
      'git~2/x',
      'a.git/x',
      '.gi/x',
      'gıt~1/x',
    ]) {
      expect(isSafeRelativePath(p), p).toBe(true);
    }
  });
});

describe('save progress', () => {
  it('adds writing and publishing after the capture stages', () => {
    expect(
      SaveProgress.parse({ stage: 'write', attempt: 1, filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 9 }),
    ).toBeTruthy();
    expect(
      SaveProgress.safeParse({
        stage: 'publish',
        attempt: 1,
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        eta: 3,
      }).success,
    ).toBe(false);
  });
});
