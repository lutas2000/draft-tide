import { createHash, randomUUID } from 'node:crypto';
import {
  DRAFT_TIDE_IDENTITY,
  DtError,
  IsoTimestamp,
  OperationId,
  PROJECT_CONFIG_FILE,
  formatCommitMessage,
  readCommitMetadata,
  type Origin,
  type SnapshotMetadata,
} from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import {
  readHistory,
  saveSnapshot,
  type GitBlobMode,
  type GitCommit,
  type IndexLockState,
  type ProjectGit,
  type PublishRequest,
  type SaveOptions,
  type TreeEntryInput,
} from '../src/index.ts';
import { World, oidOf } from './world.ts';

// saveSnapshot's decisions over an in-memory repo: what is written, when
// nothing is, and what each refusal leaves behind. The same flow on real Git
// is in the companion's integration tests.

const NOW = IsoTimestamp.parse('2026-10-02T08:30:00.123Z');
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const notUsed = (): never => {
  throw new Error('not used by saveSnapshot');
};

class Repo extends World {
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  trees = new Map<string, TreeEntryInput[]>();
  prepared = new Map<string, string>();
  lock: IndexLockState = { held: false };
  published: PublishRequest[] = [];
  created = 0;
  removedStaging = 0;
  // Runs inside publish, before the compare-and-swap.
  beforePublish: () => void = () => undefined;
  wrongBlobIds = false;

  treeOf(entries: readonly TreeEntryInput[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    const oid = sha1(JSON.stringify(sorted));
    this.trees.set(oid, sorted);
    return oid;
  }

  commit(tree: string, message: string): string {
    const parents = this.probe.tip ? [this.probe.tip] : [];
    const oid = sha1(`${tree}${parents.join()}${message}${this.commits.size}`);
    this.commits.set(oid, { tree, parents, message });
    return oid;
  }

  // What another tool's plain `git commit` of the current index would do.
  commitIndex(message = 'external change\n'): string {
    const tree = this.treeOf(
      [...this.index.values()].map((e) => ({ path: e.path, mode: e.mode as GitBlobMode, oid: e.oid })),
    );
    const oid = this.commit(tree, message);
    this.probe = { ...this.probe, tip: oid };
    return oid;
  }

  git(): ProjectGit {
    return {
      ...this.repo(),
      init: notUsed,
      writeBlobs: (paths, onWritten) =>
        Promise.resolve(
          paths.map((p, i) => {
            const bytes = this.staged.get(p);
            if (!bytes) throw new Error(`nothing staged at ${p}`);
            const oid = this.wrongBlobIds ? sha1('wrong') : oidOf(bytes);
            this.blobs.add(oid);
            onWritten?.(i);
            return oid;
          }),
        ),
      prepareIndex: (operationId, entries) => {
        if (entries.some((e) => !this.blobs.has(e.oid))) throw new DtError('GIT_FAILED', 'missing object');
        const tree = this.treeOf(entries);
        this.prepared.set(operationId, tree);
        return Promise.resolve(tree);
      },
      prepareIndexFromTree: notUsed,
      discardPreparedIndex: (operationId) => {
        this.prepared.delete(operationId);
        return Promise.resolve();
      },
      createCommit: ({ tree, message }) => {
        this.created++;
        return Promise.resolve(this.commit(tree, message));
      },
      publish: (req) => {
        if (!this.prepared.has(req.operationId)) throw new Error('publish without a prepared index');
        this.beforePublish();
        if (this.lock.held) {
          this.prepared.delete(req.operationId);
          return Promise.reject(new DtError('LOCKED', 'locked', { lock: 'index' }));
        }
        if (this.probe.tip !== req.expectedOld) {
          this.prepared.delete(req.operationId);
          return Promise.reject(new DtError('HISTORY_CHANGED', 'moved'));
        }
        const tree = this.commits.get(req.commit)?.tree as string;
        this.index = new Map(
          (this.trees.get(tree) ?? []).map((e) => [e.path, { ...e, stage: 0, flag: null }] as const),
        );
        this.probe = { ...this.probe, tip: req.commit };
        this.prepared.delete(req.operationId);
        this.published.push(req);
        return Promise.resolve();
      },
      finishPublish: notUsed,
      indexLock: () => Promise.resolve(this.lock),
      releaseIndexLock: notUsed,
      readRef: notUsed,
      readCommits: (oids) =>
        Promise.resolve(
          oids.map((oid): GitCommit => {
            const c = this.commits.get(oid);
            if (!c) throw new DtError('GIT_FAILED', 'missing commit');
            const who = { name: 'Fixture', email: 'f@example.com', time: 1_790_000_000, offset: '+0000' };
            return { oid, ...c, author: who, committer: who, truncated: false };
          }),
        ),
      firstParentLine: (tip, { skip, limit }) => {
        const line: string[] = [];
        for (let c: string | undefined = tip; c; c = this.commits.get(c)?.parents[0]) line.push(c);
        return Promise.resolve(line.slice(skip, skip + limit));
      },
      listTree: notUsed,
      lookupPath: (tree, path) => {
        const e = this.trees.get(tree)?.find((t) => t.path === path);
        return Promise.resolve(e ? { ...e, type: 'blob' as const, size: 0 } : null);
      },
      streamBlob: notUsed,
      isAncestor: notUsed,
    };
  }

  saveOptions(extra: Partial<SaveOptions> = {}): SaveOptions {
    const staging = this.staging();
    return {
      workspace: this.workspace(),
      retryDelayMs: () => 0,
      repo: this.git(),
      staging: {
        ...staging,
        remove: () => {
          this.removedStaging++;
          return staging.remove();
        },
      },
      operationId: OperationId.parse(randomUUID()),
      origin: 'gui',
      identity: DRAFT_TIDE_IDENTITY,
      clock: { nowIso: () => NOW },
      ...extra,
    };
  }
}

function fixture(): Repo {
  const r = new Repo();
  r.write('index.html', '<h1>hi</h1>');
  r.write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  return r;
}

// A repo whose history already holds a Draft Tide version.
function adopted(): Repo {
  const r = fixture();
  r.track('index.html', 'img/logo.png', PROJECT_CONFIG_FILE);
  const meta: SnapshotMetadata = {
    schemaVersion: 1,
    snapshotId: randomUUID() as SnapshotMetadata['snapshotId'],
    kind: 'baseline',
    createdAt: NOW,
    origin: 'gui',
  };
  r.commitIndex(formatCommitMessage(meta));
  return r;
}

async function rejection(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

describe('saveSnapshot', () => {
  it('makes the first version of a new repo a baseline with its metadata in the message', async () => {
    const r = fixture();
    const options = r.saveOptions({ name: '  First pass  ' });
    const saved = await saveSnapshot(options);

    expect(saved).toMatchObject({ kind: 'baseline', parent: null, branch: 'main', createdAt: NOW, files: 3 });
    expect(saved.newObjects).toBe(3);
    expect(r.probe.tip).toBe(saved.commit);
    expect(r.published).toEqual([
      {
        operationId: options.operationId,
        ref: 'refs/heads/main',
        expectedOld: null,
        commit: saved.commit,
        reflogMessage: 'draft-tide: baseline',
      },
    ]);
    const message = r.commits.get(saved.commit)?.message as string;
    expect(message.split('\n')[0]).toBe('First pass');
    expect(readCommitMetadata(message)).toEqual({
      status: 'snapshot',
      metadata: {
        schemaVersion: 1,
        snapshotId: saved.snapshotId,
        kind: 'baseline',
        createdAt: NOW,
        origin: 'gui',
        name: 'First pass',
        operationId: options.operationId,
      },
    });
    expect(r.prepared.size).toBe(0);
    expect(r.removedStaging).toBe(1);
  });

  it('builds on existing history, and stays a baseline until the settings file is in it', async () => {
    const r = fixture();
    r.track('index.html');
    const userTip = r.commitIndex();
    const saved = await saveSnapshot(r.saveOptions());
    expect(saved).toMatchObject({ kind: 'baseline', parent: userTip });

    r.write('index.html', '<h1>v2</h1>');
    const next = await saveSnapshot(r.saveOptions());
    expect(next).toMatchObject({ kind: 'manual', parent: saved.commit });
  });

  it.each<[Origin, string]>([
    ['gui', 'manual'],
    ['cli', 'agent-requested'],
    ['mcp', 'agent-requested'],
  ])('records a save from %s as %s', async (origin, kind) => {
    const r = adopted();
    r.write('index.html', '<h1>changed</h1>');
    const saved = await saveSnapshot(r.saveOptions({ origin }));
    expect(saved.kind).toBe(kind);
    const meta = readCommitMetadata(r.commits.get(saved.commit)?.message as string);
    expect(meta).toMatchObject({ status: 'snapshot', metadata: { origin, kind } });
  });

  it('writes only the content Git does not have, once per distinct content', async () => {
    const r = adopted();
    r.write('index.html', '<h1>new</h1>');
    r.write('copy.html', '<h1>new</h1>');
    r.write('logo-copy.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const progress: string[] = [];
    const saved = await saveSnapshot(r.saveOptions({ onProgress: (p) => progress.push(`${p.stage}:${p.filesDone}`) }));
    expect(saved.newObjects).toBe(1);
    expect(saved.newBytes).toBe('<h1>new</h1>'.length);
    expect(progress).toEqual(expect.arrayContaining(['hash:1', 'write:0', 'write:1', 'publish:0']));
    expect(progress.indexOf('write:1')).toBeLessThan(progress.indexOf('publish:0'));
  });

  it('refuses a save that would change nothing, leaving no trace', async () => {
    const r = adopted();
    const tip = r.probe.tip;
    const err = await rejection(saveSnapshot(r.saveOptions()));
    expect(err.code).toBe('NO_CHANGES');
    expect(err.details).toEqual({ commit: tip });
    expect(r.created).toBe(0);
    expect(r.probe.tip).toBe(tip);
    expect(r.prepared.size).toBe(0);
    expect(r.removedStaging).toBe(1);
  });

  it('refuses before capturing while an earlier publish still holds its lock', async () => {
    const r = adopted();
    r.write('index.html', '<h1>changed</h1>');
    const held = OperationId.parse(randomUUID());
    r.lock = { held: true, by: 'draft-tide', operationId: held };
    const err = await rejection(saveSnapshot(r.saveOptions()));
    expect(err.code).toBe('RECOVERY_REQUIRED');
    expect(err.details).toEqual({ operationId: held });
    expect(r.calls.prepare).toEqual([]);
  });

  it('passes LOCKED and HISTORY_CHANGED through with nothing changed, and a retry builds on the other commit', async () => {
    const r = adopted();
    r.write('index.html', '<h1>changed</h1>');
    const tip = r.probe.tip;
    r.lock = { held: true, by: 'other' };
    expect((await rejection(saveSnapshot(r.saveOptions()))).code).toBe('LOCKED');
    expect(r.probe.tip).toBe(tip);
    expect(r.prepared.size).toBe(0);
    expect(r.removedStaging).toBe(1);

    r.lock = { held: false };
    let theirs = '';
    r.beforePublish = () => {
      r.beforePublish = () => undefined;
      theirs = r.commitIndex('an engineer committed meanwhile\n');
    };
    expect((await rejection(saveSnapshot(r.saveOptions()))).code).toBe('HISTORY_CHANGED');
    expect(r.probe.tip).toBe(theirs);
    const retried = await saveSnapshot(r.saveOptions());
    expect(retried.parent).toBe(theirs);
  });

  it('stops when Git stores different content than was captured', async () => {
    const r = adopted();
    r.write('index.html', '<h1>changed</h1>');
    r.wrongBlobIds = true;
    const err = await rejection(saveSnapshot(r.saveOptions()));
    expect(err.code).toBe('GIT_FAILED');
    expect(r.created).toBe(0);
    expect(r.prepared.size).toBe(0);
  });

  it('honors a cancel up to the commit, and never after publishing starts', async () => {
    const r = adopted();
    r.write('index.html', '<h1>changed</h1>');
    const tip = r.probe.tip;
    const ac = new AbortController();
    const git = r.git();
    const options = r.saveOptions({
      repo: {
        ...git,
        createCommit: async (input, signal) => {
          const oid = await git.createCommit(input, signal);
          ac.abort(new Error('cancelled'));
          return oid;
        },
      },
      signal: ac.signal,
    });
    await expect(saveSnapshot(options)).rejects.toThrow('cancelled');
    expect(r.probe.tip).toBe(tip);
    expect(r.published).toEqual([]);
    expect(r.prepared.size).toBe(0);
  });

  it('checks the name and the repo before reading anything', async () => {
    const r = adopted();
    expect((await rejection(saveSnapshot(r.saveOptions({ name: 'two\nlines' })))).code).toBe('INVALID_ARGUMENT');
    r.probe = { ...r.probe, hasRepo: false, headRef: null, branch: null, tip: null };
    const err = await rejection(saveSnapshot(r.saveOptions()));
    expect(err.code).toBe('LOCAL_ROOT_UNAVAILABLE');
    expect(err.details['reason']).toBe('repo-missing');
    r.probe = {
      ...r.probe,
      hasRepo: true,
      blockers: [{ code: 'REPO_UNSUPPORTED', reason: 'detached-head', details: {} }],
    };
    expect((await rejection(saveSnapshot(r.saveOptions()))).code).toBe('REPO_UNSUPPORTED');
    expect(r.calls.prepare).toEqual([]);
  });
});

describe('readHistory', () => {
  it('lists the first-parent line with snapshots, external changes and unreadable metadata', async () => {
    const r = adopted();
    const baseline = r.probe.tip as string;
    r.write('index.html', '<h1>v2</h1>');
    const manual = await saveSnapshot(r.saveOptions({ name: 'Pricing' }));
    r.write('index.html', '<h1>by hand</h1>');
    r.track('index.html');
    const external = r.commitIndex('Tweak copy\n\nwritten by an engineer\n');
    r.write('index.html', '<h1>v4</h1>');
    r.track('index.html');
    const forged = r.commitIndex('Looks like ours\n\nDraft-Tide-Snapshot: {"schemaVersion":1}\n');

    const entries = await readHistory(r.git(), r.probe.tip, { skip: 0, limit: 10 });
    expect(entries.map((e) => e.commit)).toEqual([forged, external, manual.commit, baseline]);
    expect(entries.map((e) => [e.title, e.snapshot?.kind ?? null, e.unreadable])).toEqual([
      ['Looks like ours', null, 'invalid'],
      ['Tweak copy', null, null],
      ['Pricing', 'manual', null],
      ['Baseline', 'baseline', null],
    ]);
    expect(entries[2]?.snapshot?.snapshotId).toBe(manual.snapshotId);
    expect(entries[0]?.committedAt).toBe('2026-09-21T14:13:20.000Z');
    expect((await readHistory(r.git(), r.probe.tip, { skip: 1, limit: 2 })).map((e) => e.commit)).toEqual([
      external,
      manual.commit,
    ]);
    expect(await readHistory(r.git(), null, { skip: 0, limit: 10 })).toEqual([]);
  });
});
