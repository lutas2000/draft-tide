import { createHash, randomUUID } from 'node:crypto';
import {
  DtError,
  IsoTimestamp,
  OperationId,
  SnapshotId,
  formatCommitMessage,
  type SnapshotMetadata,
} from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import {
  HashCache,
  buildLineIndex,
  historyEntryOf,
  printable,
  resolveVersionRef,
  workingStatus,
  type FileIdentity,
  type GitCommit,
  type GitHistory,
  type GitTreeEntry,
} from '../src/index.ts';
import { World, oidOf } from './world.ts';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function meta(over: Partial<SnapshotMetadata> = {}): SnapshotMetadata {
  return {
    schemaVersion: 1,
    snapshotId: SnapshotId.parse(randomUUID()),
    kind: 'manual',
    createdAt: IsoTimestamp.parse('2026-10-02T08:30:00.123Z'),
    origin: 'gui',
    operationId: OperationId.parse(randomUUID()),
    ...over,
  };
}

// A first-parent line, oldest first as it is built, with paging like Git's.
class Line {
  commits: GitCommit[] = [];
  readBatches: number[] = [];

  add(message: string, author = 'Draft Tide'): GitCommit {
    const parent = this.commits.at(-1)?.oid;
    const oid = sha1(`${message}${this.commits.length}`);
    const person = { name: author, email: 'x@example.com', time: 1_790_000_000 + this.commits.length, offset: '+0000' };
    const c: GitCommit = {
      oid,
      tree: sha1(`tree${oid}`),
      parents: parent ? [parent] : [],
      author: person,
      committer: person,
      message,
      truncated: false,
    };
    this.commits.push(c);
    return c;
  }

  git(): Pick<GitHistory, 'firstParentLine' | 'readCommits'> {
    return {
      firstParentLine: (tip, { skip, limit }) => {
        const newestFirst = [...this.commits].reverse();
        const from = newestFirst.findIndex((c) => c.oid === tip);
        return Promise.resolve(newestFirst.slice(from + skip, from + skip + limit).map((c) => c.oid));
      },
      readCommits: (oids) => {
        this.readBatches.push(oids.length);
        return Promise.resolve(oids.map((o) => this.commits.find((c) => c.oid === o) as GitCommit));
      },
    };
  }

  get tip(): string {
    return this.commits.at(-1)?.oid ?? '';
  }
}

describe('the line index', () => {
  it('numbers versions from the oldest and leaves other tools’ commits unnumbered', async () => {
    const line = new Line();
    const v1 = meta({ kind: 'baseline' });
    line.add('Initial import\n', 'Engineer');
    line.add(formatCommitMessage(v1));
    line.add('Tweak copy\n', 'Engineer');
    const v2 = meta({ name: 'Pricing' });
    line.add(formatCommitMessage(v2));
    const index = await buildLineIndex(line.git(), line.tip);
    const entries = [...line.commits].reverse().map((c) => historyEntryOf(c, index));
    expect(entries.map((e) => [e.source, e.seq, e.title])).toEqual([
      ['draft-tide', 2, 'Pricing'],
      ['external', null, 'Tweak copy'],
      ['draft-tide', 1, 'Baseline'],
      ['external', null, 'Initial import'],
    ]);
    expect(entries[0]?.snapshot).toMatchObject({ snapshotId: v2.snapshotId, name: 'Pricing', restoreOf: null });
    expect(entries[1]?.authorName).toBe('Engineer');
  });

  it('treats a later commit repeating a snapshot id as a copy of the oldest one', async () => {
    const line = new Line();
    const v1 = meta();
    const original = line.add(formatCommitMessage(v1));
    line.add('External\n');
    const copy = line.add(formatCommitMessage(v1));
    const index = await buildLineIndex(line.git(), line.tip);
    expect(historyEntryOf(copy, index)).toMatchObject({
      source: 'copy',
      copyOf: original.oid,
      snapshot: null,
      seq: null,
    });
    expect(historyEntryOf(original, index)).toMatchObject({ source: 'draft-tide', seq: 1 });
    expect(resolveVersionRef(index, v1.snapshotId)).toBe(original.oid);
  });

  it('resolves snapshot ids and commits on the line, nothing else', async () => {
    const line = new Line();
    const v1 = meta();
    const c1 = line.add(formatCommitMessage(v1));
    const ext = line.add('Engineer change\n');
    const index = await buildLineIndex(line.git(), line.tip);
    expect(resolveVersionRef(index, v1.snapshotId)).toBe(c1.oid);
    expect(resolveVersionRef(index, ext.oid)).toBe(ext.oid);
    for (const ref of [randomUUID(), sha1('elsewhere')]) {
      expect(() => resolveVersionRef(index, ref)).toThrow(DtError);
      try {
        resolveVersionRef(index, ref);
      } catch (e) {
        expect((e as DtError).code).toBe('SNAPSHOT_NOT_FOUND');
      }
    }
  });

  it('reads untrusted metadata as unreadable and newer schemas as such', async () => {
    const line = new Line();
    const forged = line.add(`Looks real\n\nDraft-Tide-Snapshot: {"kind": "manual"}\n`);
    const json = formatCommitMessage(meta()).replace('"schemaVersion":1', '"schemaVersion":9');
    const newer = line.add(json);
    const index = await buildLineIndex(line.git(), line.tip);
    expect(historyEntryOf(forged, index)).toMatchObject({ source: 'unreadable', unreadable: 'invalid', seq: null });
    expect(historyEntryOf(newer, index)).toMatchObject({ source: 'unreadable', unreadable: 'newer-schema' });
  });

  it('makes other tools’ titles and names safe to show', async () => {
    const line = new Line();
    const c = line.add('Fix \u001b[31mred\u001b[0m ‮reversed\n', 'Eve\u0007');
    const index = await buildLineIndex(line.git(), line.tip);
    const e = historyEntryOf(c, index);
    expect(e.title).toBe('Fix �[31mred�[0m �reversed');
    expect(e.authorName).toBe('Eve�');
    expect(printable('🌊'.repeat(300), 200)).toBe('🌊'.repeat(200));
  });

  it('reads long lines in bounded batches', async () => {
    const line = new Line();
    for (let i = 0; i < 450; i++) line.add(formatCommitMessage(meta()));
    const index = await buildLineIndex(line.git(), line.tip);
    expect(index.commits).toHaveLength(450);
    expect(index.seqOf.size).toBe(450);
    expect(Math.max(...line.readBatches)).toBeLessThanOrEqual(200);
  });
});

describe('the status hash cache', () => {
  const id = (mtimeMs: number, ino = 1n): FileIdentity => ({
    dev: 1n,
    ino,
    size: 3n,
    mtimeNs: BigInt(mtimeMs) * 1_000_000n,
    ctimeNs: BigInt(mtimeMs) * 1_000_000n,
  });
  const digest = { oid: 'a'.repeat(40), size: 3, executable: false, hasCR: false };

  it('remembers a digest only for the same file identity', () => {
    const cache = new HashCache();
    cache.set('a', id(1000), digest, 10_000);
    expect(cache.get('a', id(1000))).toEqual(digest);
    expect(cache.get('a', id(1001))).toBeNull();
    expect(cache.get('a', id(1000, 2n))).toBeNull();
  });

  it('does not remember a file written within two seconds of reading it (racily clean)', () => {
    const cache = new HashCache();
    cache.set('a', id(9_000), digest, 10_000);
    expect(cache.get('a', id(9_000))).toBeNull();
    cache.set('a', id(7_000), digest, 10_000);
    expect(cache.get('a', id(7_000))).toEqual(digest);
  });

  it('forgets files that left the scope', () => {
    const cache = new HashCache();
    cache.set('a', id(1), digest, 10_000);
    cache.set('b', id(1), digest, 10_000);
    cache.retain(new Set(['b']));
    expect(cache.size).toBe(1);
  });
});

describe('workingStatus', () => {
  function tipOf(world: World): GitTreeEntry[] {
    return [...world.index.values()].map((e) => ({
      path: e.path,
      mode: e.mode,
      type: 'blob' as const,
      oid: e.oid,
      size: world.files.get(e.path)?.bytes.length ?? 0,
    }));
  }

  it('lists what the next save would record, and hashes unchanged files once', async () => {
    const world = new World();
    world.write('index.html', '<h1>v1</h1>');
    world.write('logo.png', 'png');
    world.write('old.css', 'x');
    world.track('.drafttide.json', 'index.html', 'logo.png', 'old.css');
    const tipFiles = tipOf(world);
    world.write('index.html', '<h1>v2</h1>');
    world.files.delete('old.css');
    world.write('assets/logo.png', 'png');
    world.files.delete('logo.png');
    world.write('new.js', 'js');
    let hashed = 0;
    world.onRead = () => hashed++;
    const cache = new HashCache();
    const args = {
      repo: world.repo(),
      workspace: world.workspace(),
      probe: world.probe,
      config: world.config,
      tipFiles,
      cache,
      nowMs: Date.now() + 60_000,
    };
    const first = await workingStatus(args);
    expect(first.changes.map((c) => [c.change, c.path, c.previousPath])).toEqual([
      ['renamed', 'assets/logo.png', 'logo.png'],
      ['modified', 'index.html', null],
      ['added', 'new.js', null],
      ['deleted', 'old.css', null],
    ]);
    expect(first.counts).toEqual({ total: 4, added: 1, modified: 1, deleted: 1, renamed: 1 });
    const firstReads = hashed;
    await workingStatus(args);
    expect(hashed).toBe(firstReads);
  });

  it('reports unsupported entries and never calls them deletions', async () => {
    const world = new World();
    world.write('index.html', 'x');
    world.track('.drafttide.json', 'index.html');
    world.symlinks.add('link');
    const status = await workingStatus({
      repo: world.repo(),
      workspace: world.workspace(),
      probe: world.probe,
      config: world.config,
      tipFiles: [
        ...tipOf(world),
        { path: 'link', mode: '120000', type: 'blob', oid: oidOf(Buffer.from('t')), size: 1 },
      ],
      cache: new HashCache(),
      nowMs: Date.now(),
    });
    expect(status.unsupported).toEqual([{ path: 'link', kind: 'symlink' }]);
    expect(status.changes).toEqual([]);
  });
});
