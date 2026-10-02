import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAFT_TIDE_IDENTITY, DtError, IsoTimestamp, OperationId, type CommitIdentity } from '@draft-tide/contracts';
import type { GitBlobMode, ProjectGit, TreeEntryInput } from '@draft-tide/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HARDENING,
  createHistory,
  gitTrace,
  openGitRepo,
  runGit,
  streamGit,
  type OpenGitRepoOptions,
  type RunOptions,
} from '../src/index.ts';
import {
  cleanupTempDirs,
  committedRepo,
  gitRuntime,
  gitStatus,
  onWindows,
  plainGit,
  plainGitResult,
  tempDir,
  write,
} from './helpers.ts';

const rt = gitRuntime();
afterAll(cleanupTempDirs);

const NOW = IsoTimestamp.parse('2026-10-02T08:30:00.123Z');
const MAIN = 'refs/heads/main';
const newOp = () => OperationId.parse(randomUUID());

async function dtError(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

function open(root: string, options: OpenGitRepoOptions = {}): ProjectGit {
  return openGitRepo(rt, root, options);
}

// Writes the working files as blobs and builds their tree, the way a save
// does from staged copies.
async function prepare(repo: ProjectGit, root: string, paths: string[], modes: Record<string, GitBlobMode> = {}) {
  const oids = await repo.writeBlobs(paths.map((p) => join(root, p)));
  const entries: TreeEntryInput[] = paths.map((path, i) => ({
    path,
    mode: modes[path] ?? '100644',
    oid: oids[i] as string,
  }));
  const operationId = newOp();
  const tree = await repo.prepareIndex(operationId, entries);
  return { operationId, tree, entries };
}

async function commitOn(
  repo: ProjectGit,
  tree: string,
  parent: string | null,
  message = 'Saved version\n',
  identity: CommitIdentity = DRAFT_TIDE_IDENTITY,
) {
  return repo.createCommit({ tree, parents: parent ? [parent] : [], message, identity, time: NOW });
}

// One complete save of these working files on main.
async function saveFiles(repo: ProjectGit, root: string, paths: string[]) {
  const { operationId, tree } = await prepare(repo, root, paths);
  const tip = await repo.readRef(MAIN);
  const commit = await commitOn(repo, tree, tip);
  await repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'draft-tide: test' });
  return { operationId, tree, commit, tip };
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();

// A history whose Git calls go through `doctor`, to simulate a Git that
// misbehaves in a way a real one only rarely does.
function doctoredHistory(
  root: string,
  doctor: (
    args: string[],
    options: RunOptions,
    real: (o: RunOptions) => ReturnType<typeof runGit>,
  ) => ReturnType<typeof runGit>,
) {
  const prefix = [`--git-dir=${join(root, '.git')}`, `--work-tree=${root}`, ...HARDENING];
  return createHistory({
    rt,
    root,
    gitDir: join(root, '.git'),
    run: (args, options = {}) => doctor(args, options, (o) => runGit(rt, [...prefix, ...args], root, o)),
    stream: (args, signal) => streamGit(rt, [...prefix, ...args], root, { signal }),
  });
}
const preparedIndexes = (root: string) => readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.dt-'));

describe('init', () => {
  it('creates a repo on main with no hooks or sample files', async () => {
    const root = tempDir('dt-init-');
    write(root, 'index.html', 'x');
    const repo = open(root);
    await repo.init();
    expect(readdirSync(join(root, '.git')).sort()).toEqual(['HEAD', 'config', 'objects', 'refs']);
    expect(await repo.probe()).toMatchObject({ hasRepo: true, headRef: MAIN, branch: 'main', tip: null, blockers: [] });
    expect(plainGit(root, ['rev-parse', '--show-object-format']).trim()).toBe('sha1');
    expect(await dtError(repo.init())).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('refuses every history operation on a scratch git dir', () => {
    const root = tempDir();
    const repo = open(root, { scratchGitDir: tempDir('dt-scratch-') });
    expect(() => repo.writeBlobs([])).toThrow('scratch');
    expect(() => repo.init()).toThrow('scratch');
    expect(() => repo.publish({} as never)).toThrow('scratch');
  });
});

describe('writing objects and trees', () => {
  it('stores raw bytes as blobs, unfiltered, with the ids plain Git computes without filters', async () => {
    const root = committedRepo({ 'index.html': 'x' });
    // Git would normalize these on a plain `git add` / `hash-object`.
    plainGit(root, ['config', 'core.autocrlf', 'true']);
    write(root, '.gitattributes', '*.txt text\n');
    const crlf = 'one\r\ntwo\r\n';
    write(root, 'a.txt', crlf);
    const bin = randomBytes(300 * 1024);
    write(root, 'b.bin', bin);
    write(root, 'empty', '');
    const repo = open(root);
    const written: number[] = [];
    const oids = await repo.writeBlobs(
      ['a.txt', 'b.bin', 'empty'].map((p) => join(root, p)),
      (i) => written.push(i),
    );
    expect(written).toEqual([0, 1, 2]);
    expect(oids).toEqual(
      ['a.txt', 'b.bin', 'empty'].map((p) => plainGit(root, ['hash-object', '--no-filters', p]).trim()),
    );
    // Control: with filters, plain Git stores different bytes for the CRLF file.
    expect(plainGit(root, ['hash-object', 'a.txt']).trim()).not.toBe(oids[0]);
    expect(Buffer.from(plainGit(root, ['cat-file', 'blob', oids[0] as string]))).toEqual(Buffer.from(crlf));
    expect(await repo.writeBlobs([])).toEqual([]);
    expect(await dtError(repo.writeBlobs([join(root, 'a\nb')]))).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('builds the same tree plain Git builds from the same files', async () => {
    const root = committedRepo({ 'index.html': '<h1>v1</h1>\n' });
    const files: Record<string, string | Buffer> = {
      'index.html': '<h1>v2</h1>\n',
      'css/site.css': 'body{}\n',
      'img/hero.png': randomBytes(4096),
      '頁面/定價 頁.html': '<h1>定價</h1>\n',
      'emoji 🎨.svg': '<svg/>\n',
      'run.sh': '#!/bin/sh\n',
    };
    for (const [p, c] of Object.entries(files)) write(root, p, c);
    const modes: Record<string, GitBlobMode> = {};
    if (!onWindows) {
      chmodSync(join(root, 'run.sh'), 0o755);
      modes['run.sh'] = '100755';
    }
    const repo = open(root);
    const { tree, operationId } = await prepare(repo, root, Object.keys(files), modes);
    expect(preparedIndexes(root)).toEqual([`index.dt-${operationId}`]);
    // Nothing but objects and the prepared index so far: the real index still
    // describes the old commit.
    expect(plainGit(root, ['ls-files'])).toBe('index.html\n');
    plainGit(root, ['add', '-A']);
    expect(plainGit(root, ['write-tree']).trim()).toBe(tree);
    await repo.discardPreparedIndex(operationId);
    expect(preparedIndexes(root)).toEqual([]);
  });

  it('refuses a tree whose objects are missing, and cleans up', async () => {
    const root = committedRepo();
    const repo = open(root);
    const operationId = newOp();
    const err = await dtError(repo.prepareIndex(operationId, [{ path: 'a.txt', mode: '100644', oid: '1'.repeat(40) }]));
    expect(err.code).toBe('GIT_FAILED');
    expect(preparedIndexes(root)).toEqual([]);
  });

  it('refuses unsafe or repeated paths before Git sees them', async () => {
    const root = committedRepo();
    const repo = open(root);
    const oid = (await repo.writeBlobs([join(root, 'index.html')]))[0] as string;
    for (const entries of [
      [{ path: 'GIT~1/config', mode: '100644' as const, oid }],
      [{ path: '.g\u200cit/hooks/pre-commit', mode: '100644' as const, oid }],
      [{ path: '../x', mode: '100644' as const, oid }],
      [
        { path: 'a', mode: '100644' as const, oid },
        { path: 'a', mode: '100644' as const, oid },
      ],
    ]) {
      expect((await dtError(repo.prepareIndex(newOp(), entries))).code).toBe('INTERNAL_ERROR');
    }
  });

  it('never lets Git drop an entry silently', async () => {
    // update-index skips a path it refuses with exit code 0. Simulate a Git
    // that drops one entry: the prepared index is checked against the input.
    const root = committedRepo();
    const history = doctoredHistory(root, (args, options, real) =>
      args[0] === 'update-index' && typeof options.input === 'string'
        ? real({ ...options, input: options.input.split('\0').slice(1).join('\0') })
        : real(options),
    );
    const repo = open(root);
    const oid = (await repo.writeBlobs([join(root, 'index.html')]))[0] as string;
    const operationId = newOp();
    const err = await dtError(
      history.prepareIndex(operationId, [
        { path: 'a.html', mode: '100644', oid },
        { path: 'b.html', mode: '100644', oid },
      ]),
    );
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(err.details['entries']).toEqual([{ path: 'a.html', kind: 'invalid-name' }]);
    expect(preparedIndexes(root)).toEqual([]);
  });
});

describe('commits', () => {
  it('records exactly the given identity, time and message, unsigned', async () => {
    const root = committedRepo();
    const repo = open(root);
    const { tree, operationId } = await prepare(repo, root, ['index.html']);
    const parent = head(root);
    const identity = { name: '設計師 王', email: '12345+wang@users.noreply.github.com' };
    const message = 'Compact pricing 🎨\n\nDraft-Tide-Snapshot: {"x":1}\n';
    const commit = await commitOn(repo, tree, parent, message, identity);
    await repo.discardPreparedIndex(operationId);
    const raw = plainGit(root, ['cat-file', 'commit', commit]);
    expect(raw).toBe(
      [
        `tree ${tree}`,
        `parent ${parent}`,
        `author 設計師 王 <12345+wang@users.noreply.github.com> 1790929800 +0000`,
        `committer 設計師 王 <12345+wang@users.noreply.github.com> 1790929800 +0000`,
        '',
        message,
      ].join('\n'),
    );
    const [read] = await repo.readCommits([commit]);
    expect(read).toEqual({
      oid: commit,
      tree,
      parents: [parent],
      author: { ...identity, time: 1790929800, offset: '+0000' },
      committer: { ...identity, time: 1790929800, offset: '+0000' },
      message,
      truncated: false,
    });
  });

  it('refuses an identity Git would rewrite, and a repeated parent', async () => {
    const root = committedRepo();
    const repo = open(root);
    const tree = plainGit(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const parent = head(root);
    for (const identity of [
      { name: 'A <b>', email: 'a@b' },
      { name: 'A', email: 'a b@c' },
    ]) {
      expect((await dtError(commitOn(repo, tree, parent, 'm\n', identity))).code).toBe('INTERNAL_ERROR');
    }
    const err = await dtError(
      repo.createCommit({ tree, parents: [parent, parent], message: 'm\n', identity: DRAFT_TIDE_IDENTITY, time: NOW }),
    );
    expect(err.code).toBe('INTERNAL_ERROR');
  });
});

describe('publishing (index.lock, then compare-and-swap, then the index)', () => {
  it('moves the branch and installs the matching index, leaving git status clean', async () => {
    const root = committedRepo({ 'index.html': 'v1\n', 'keep.css': 'k\n' });
    write(root, 'index.html', 'v2\n');
    write(root, 'new.js', 'n\n');
    const repo = open(root);
    const { commit, tip, tree, operationId } = await saveFiles(repo, root, ['index.html', 'keep.css', 'new.js']);
    expect(head(root)).toBe(commit);
    expect(plainGit(root, ['rev-parse', `${commit}^`]).trim()).toBe(tip);
    expect(plainGit(root, ['rev-parse', `${commit}^{tree}`]).trim()).toBe(tree);
    expect(gitStatus(root)).toBe('');
    expect(existsSync(join(root, '.git', 'index.lock'))).toBe(false);
    expect(preparedIndexes(root)).toEqual([]);
    expect(await repo.indexLock()).toEqual({ held: false });
    expect(plainGit(root, ['reflog', '-1', '--format=%gs', 'main']).trim()).toBe('draft-tide: test');
    expect(operationId).toBeTruthy();
    // A plain commit afterwards builds on the version, with its tree.
    write(root, 'after.txt', 'a\n');
    plainGit(root, ['add', 'after.txt']);
    plainGit(root, ['commit', '--quiet', '-m', 'after']);
    expect(plainGit(root, ['ls-tree', '--name-only', 'HEAD']).split('\n')).toEqual(
      expect.arrayContaining(['index.html', 'keep.css', 'new.js', 'after.txt']),
    );
    expect(plainGit(root, ['show', 'HEAD:index.html'])).toBe('v2\n');
  });

  it('creates the branch on a new repo', async () => {
    const root = tempDir('dt-new-');
    write(root, 'index.html', 'first\n');
    const repo = open(root);
    await repo.init();
    const { commit } = await saveFiles(repo, root, ['index.html']);
    expect(await repo.readRef(MAIN)).toBe(commit);
    expect(plainGit(root, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(gitStatus(root)).toBe('');
  });

  it('fails with LOCKED, changing nothing, while another Git holds index.lock', async () => {
    const root = committedRepo();
    write(root, 'index.html', 'changed\n');
    const repo = open(root);
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, 'held by another git');
    const indexBefore = readFileSync(join(root, '.git', 'index'));
    const err = await dtError(
      repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x', lockWaitMs: 50 }),
    );
    expect(err).toMatchObject({ code: 'LOCKED', retryable: true, details: { lock: 'index' } });
    expect(head(root)).toBe(tip);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore);
    expect(readFileSync(lock, 'utf8')).toBe('held by another git');
    expect(await repo.indexLock()).toEqual({ held: true, by: 'other' });
    expect(preparedIndexes(root)).toEqual([]);
  });

  it('waits briefly for a lock another Git is about to release', async () => {
    const root = committedRepo();
    write(root, 'index.html', 'changed\n');
    const repo = open(root);
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, 'brief');
    setTimeout(() => rmSync(lock), 150);
    await repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x', lockWaitMs: 5000 });
    expect(head(root)).toBe(commit);
  });

  it('fails with HISTORY_CHANGED, overwriting nothing, when someone committed meanwhile', async () => {
    const root = committedRepo();
    write(root, 'index.html', 'designer\n');
    const repo = open(root);
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    write(root, 'other.txt', 'engineer\n');
    plainGit(root, ['add', 'other.txt']);
    plainGit(root, ['commit', '--quiet', '-m', 'engineer']);
    const theirs = head(root);
    const theirIndex = readFileSync(join(root, '.git', 'index'));
    const err = await dtError(repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' }));
    expect(err).toMatchObject({ code: 'HISTORY_CHANGED', retryable: true });
    expect(head(root)).toBe(theirs);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(theirIndex);
    expect(await repo.indexLock()).toEqual({ held: false });
    expect(preparedIndexes(root)).toEqual([]);

    // Also when the branch was created by someone else first.
    const fresh = tempDir('dt-race-');
    write(fresh, 'a.txt', 'a\n');
    const r2 = open(fresh);
    await r2.init();
    const p2 = await prepare(r2, fresh, ['a.txt']);
    const c2 = await commitOn(r2, p2.tree, null);
    plainGit(fresh, ['add', 'a.txt']);
    plainGit(fresh, ['commit', '--quiet', '-m', 'first by hand']);
    const e2 = await dtError(
      r2.publish({ operationId: p2.operationId, ref: MAIN, expectedOld: null, commit: c2, reflogMessage: 'x' }),
    );
    expect(e2.code).toBe('HISTORY_CHANGED');
  });

  it('fails with LOCKED when another Git is updating the branch', async () => {
    const root = committedRepo();
    write(root, 'index.html', 'changed\n');
    const repo = open(root);
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main.lock'), '');
    const err = await dtError(repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' }));
    expect(err).toMatchObject({ code: 'LOCKED', details: { lock: 'ref' } });
    expect(head(root)).toBe(tip);
    expect(await repo.indexLock()).toEqual({ held: false });
  });

  it('holds the lock between the ref update and the index switch, so no plain commit can slip in', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    let attempts: { status: number; stderr: string }[] = [];
    const repo = open(root, {
      testHooks: {
        afterRefUpdate: () => {
          // The ref has moved; the real index still describes v1. A plain
          // commit now would record v1 on top of the new version.
          attempts = [
            plainGitResult(root, ['commit', '--quiet', '--allow-empty', '-m', 'sneaky']),
            plainGitResult(root, ['add', 'index.html']),
          ];
        },
      },
    });
    const { commit } = await saveFiles(repo, root, ['index.html']);
    expect(attempts.map((a) => a.status)).toEqual([128, 128]);
    expect(attempts[0]?.stderr).toContain('index.lock');
    expect(head(root)).toBe(commit);
    expect(gitStatus(root)).toBe('');
  });

  it('leaves its own lock when cut short after the ref moved, and finishPublish completes the switch', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    const repo = open(root, {
      testHooks: {
        afterRefUpdate: () => {
          throw new Error('crash');
        },
      },
    });
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    const err = await dtError(repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' }));
    expect(err).toMatchObject({ code: 'RECOVERY_REQUIRED', details: { operationId, commit } });
    // The version is in history; the index still holds v1, guarded by the lock.
    expect(head(root)).toBe(commit);
    expect(readFileSync(join(root, '.git', 'index.lock'), 'utf8')).toBe(`draft-tide ${operationId}\n`);
    expect(await repo.indexLock()).toEqual({ held: true, by: 'draft-tide', operationId });
    expect(preparedIndexes(root)).toEqual([`index.dt-${operationId}`]);
    expect(plainGitResult(root, ['commit', '--quiet', '--allow-empty', '-m', 'blocked']).status).toBe(128);

    // Another operation's id doesn't release or finish it.
    const other = newOp();
    await repo.releaseIndexLock(other);
    expect(await repo.indexLock()).toMatchObject({ held: true, operationId });
    expect((await dtError(repo.finishPublish(other))).code).toBe('LOCKED');

    await repo.finishPublish(operationId);
    expect(await repo.indexLock()).toEqual({ held: false });
    expect(preparedIndexes(root)).toEqual([]);
    expect(gitStatus(root)).toBe('');
  });

  it('finishes the switch even after someone deleted the lock by hand', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    const repo = open(root, {
      testHooks: {
        afterRefUpdate: () => {
          throw new Error('crash');
        },
      },
    });
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    await dtError(repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' }));
    rmSync(join(root, '.git', 'index.lock'));
    // The residual risk: the stale index now reads as a reverse change.
    expect(gitStatus(root)).not.toBe('');
    await repo.finishPublish(operationId);
    expect(gitStatus(root)).toBe('');
  });

  it('finishes the switch when Git reports a failure after moving the ref', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    const history = doctoredHistory(root, async (args, options, real) => {
      const out = await real(options);
      if (args[0] === 'update-ref') throw new DtError('GIT_FAILED', 'update-ref failed after the update');
      return out;
    });
    const repo = open(root);
    const { operationId, tree } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    const commit = await commitOn(repo, tree, tip);
    await history.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' });
    expect(head(root)).toBe(commit);
    expect(await repo.indexLock()).toEqual({ held: false });
    expect(gitStatus(root)).toBe('');
  });

  it('refuses to install an index that does not describe the commit', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    const repo = open(root);
    const { operationId } = await prepare(repo, root, ['index.html']);
    const tip = head(root);
    // A commit of the old tree, published with the new tree's index.
    const commit = await commitOn(repo, plainGit(root, ['rev-parse', 'HEAD^{tree}']).trim(), tip);
    const err = await dtError(repo.publish({ operationId, ref: MAIN, expectedOld: tip, commit, reflogMessage: 'x' }));
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(head(root)).toBe(tip);
    expect(await repo.indexLock()).toEqual({ held: false });
    expect(preparedIndexes(root)).toEqual([]);
  });

  it('refuses a publish without a prepared index, before taking anything', async () => {
    const root = committedRepo();
    const repo = open(root);
    const tip = head(root);
    const err = await dtError(
      repo.publish({ operationId: newOp(), ref: MAIN, expectedOld: tip, commit: tip, reflogMessage: 'x' }),
    );
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(await repo.indexLock()).toEqual({ held: false });
  });
});

describe('reading history', () => {
  it('reads the first-parent line in pages, through merges', async () => {
    const root = committedRepo({ 'a.txt': '1\n' });
    const first = head(root);
    plainGit(root, ['checkout', '--quiet', '-b', 'side']);
    write(root, 'side.txt', 's\n');
    plainGit(root, ['add', 'side.txt']);
    plainGit(root, ['commit', '--quiet', '-m', 'side']);
    const side = head(root);
    plainGit(root, ['checkout', '--quiet', 'main']);
    write(root, 'a.txt', '2\n');
    plainGit(root, ['commit', '--quiet', '-am', 'two']);
    const two = head(root);
    plainGit(root, ['merge', '--quiet', '--no-ff', '-m', 'merge side', 'side']);
    const merge = head(root);
    const repo = open(root);
    expect(await repo.firstParentLine(merge, { skip: 0, limit: 10 })).toEqual([merge, two, first]);
    expect(await repo.firstParentLine(merge, { skip: 1, limit: 1 })).toEqual([two]);
    expect(await repo.isAncestor(first, merge)).toBe(true);
    expect(await repo.isAncestor(side, merge)).toBe(true);
    expect(await repo.isAncestor(merge, first)).toBe(false);
    const [m] = await repo.readCommits([merge]);
    expect(m?.parents).toEqual([two, side]);
    expect((await dtError(repo.firstParentLine('HEAD', { skip: 0, limit: 1 }))).code).toBe('INTERNAL_ERROR');
  });

  it('reads history from the objects, not from grafts', async () => {
    const root = committedRepo({ 'a.txt': '1\n' });
    write(root, 'a.txt', '2\n');
    plainGit(root, ['commit', '--quiet', '-am', 'two']);
    const tip = head(root);
    write(root, '.git/info/grafts', `${tip}\n`);
    // Control: plain Git honors the graft and sees one commit.
    expect(plainGit(root, ['-c', 'advice.graftFileDeprecated=false', 'rev-list', '--count', tip]).trim()).toBe('1');
    expect(await open(root).firstParentLine(tip, { skip: 0, limit: 10 })).toHaveLength(2);
  });

  it('reads odd commits other tools write, and cuts very large ones short', async () => {
    const root = committedRepo();
    const tree = plainGit(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const parent = head(root);
    const signed = plainGit(
      root,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      // A Latin-1 message, as its encoding header says: not UTF-8.
      Buffer.from(
        [
          `tree ${tree}`,
          `parent ${parent}`,
          'author Eng <eng@example.com> 1700000000 +0800',
          'committer Eng <eng@example.com> 1700000001 -0130',
          'encoding ISO-8859-1',
          'gpgsig -----BEGIN PGP SIGNATURE-----',
          ' ',
          ' abc',
          ' -----END PGP SIGNATURE-----',
          '',
          'Caf\xe9 by hand',
          '',
        ].join('\n'),
        'latin1',
      ),
    ).trim();
    const huge = plainGit(
      root,
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      `tree ${tree}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nbig\n${'x'.repeat(1_200_000)}\n`,
    ).trim();
    const repo = open(root);
    const [a, b] = await repo.readCommits([signed, huge]);
    expect(a).toMatchObject({
      parents: [parent],
      author: { name: 'Eng', email: 'eng@example.com', time: 1700000000, offset: '+0800' },
      committer: { time: 1700000001, offset: '-0130' },
      truncated: false,
    });
    expect(a?.message).toBe('Caf\ufffd by hand\n');
    expect(b).toMatchObject({ tree, parents: [], truncated: true });
    expect(b?.message.startsWith('big\n')).toBe(true);
    expect(b?.message.length).toBeLessThan(1_100_000);

    expect((await dtError(repo.readCommits(['1'.repeat(40)]))).code).toBe('GIT_FAILED');
    expect((await dtError(repo.readCommits([tree]))).code).toBe('GIT_FAILED');
    expect(await repo.readCommits([])).toEqual([]);
  });

  it('lists a tree with modes, types, sizes and every name', async () => {
    const root = committedRepo({ 'a.txt': 'aaa', 'dir/b.bin': Buffer.alloc(10), 'run.sh': '#!/bin/sh\n' });
    const blob = plainGit(root, ['hash-object', '-w', '--stdin'], 'target').trim();
    plainGit(root, ['update-index', '--chmod=+x', 'run.sh']);
    plainGit(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
    plainGit(root, ['update-index', '--add', '--cacheinfo', `160000,${head(root)},mod`]);
    plainGit(root, ['commit', '--quiet', '-m', 'odd entries']);
    const commit = head(root);
    const repo = open(root);
    const listing = await repo.listTree(commit);
    expect(listing.nonUtf8).toEqual([]);
    expect(listing.entries.map((e) => [e.path, e.mode, e.type, e.size])).toEqual([
      ['a.txt', '100644', 'blob', 3],
      ['dir/b.bin', '100644', 'blob', 10],
      ['link', '120000', 'blob', 6],
      ['mod', '160000', 'commit', null],
      ['run.sh', '100755', 'blob', 10],
    ]);
    const tree = plainGit(root, ['rev-parse', `${commit}^{tree}`]).trim();
    expect(await repo.lookupPath(tree, 'dir/b.bin')).toMatchObject({ path: 'dir/b.bin', size: 10 });
    expect(await repo.lookupPath(tree, 'dir')).toBeNull();
    expect(await repo.lookupPath(tree, 'missing.txt')).toBeNull();

    // A name that isn't UTF-8 can only come from elsewhere; it is reported.
    const odd = plainGit(
      root,
      ['mktree', '-z'],
      Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tok\x00100644 blob ${blob}\tbad-`),
        Buffer.from([0xff]),
        Buffer.from('\0'),
      ]),
    ).trim();
    const oddListing = await repo.listTree(odd);
    expect(oddListing.entries.map((e) => e.path)).toEqual(['ok']);
    expect(oddListing.nonUtf8).toEqual(['bad-\ufffd']);
  });

  it('streams blobs with backpressure and stops Git when the reader stops', async () => {
    const root = committedRepo();
    const bytes = randomBytes(5 * 1024 * 1024 + 7);
    write(root, 'big.bin', bytes);
    const repo = open(root);
    const [oid] = await repo.writeBlobs([join(root, 'big.bin')]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of repo.streamBlob(oid as string)) chunks.push(chunk);
    // Buffer#equals: a deep toEqual over megabytes is slow.
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);

    let seen = 0;
    for await (const chunk of repo.streamBlob(oid as string)) {
      seen += chunk.length;
      break;
    }
    expect(seen).toBeGreaterThan(0);

    const ac = new AbortController();
    const reading = (async () => {
      for await (const _ of repo.streamBlob(oid as string, ac.signal)) ac.abort(new Error('cancelled'));
    })();
    await expect(reading).rejects.toThrow('cancelled');

    const missing = (async () => {
      for await (const _ of repo.streamBlob('1'.repeat(40))) {
        // nothing
      }
    })();
    expect((await dtError(missing)).code).toBe('GIT_FAILED');
  });
});

describe.skipIf(onWindows)('hostile repository (each setting with a control that fires)', () => {
  it('saves without running any hook or configured program, unsigned and in UTF-8', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    const markers = tempDir('dt-markers-');
    const script = (name: string, body = '') => {
      const p = join(markers, `${name}.sh`);
      writeFileSync(p, `#!/bin/sh\ntouch "${join(markers, `${name}.ran`)}"\n${body}`, { mode: 0o755 });
      return p;
    };
    const hooks = [
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'reference-transaction',
      'post-index-change',
      'pre-auto-gc',
    ];
    for (const dir of [join(root, '.git', 'hooks'), join(markers, 'hooks')]) {
      for (const hook of hooks) {
        write(dir, hook, `#!/bin/sh\ntouch "${join(markers, `hook-${hook}.ran`)}"\n`);
        chmodSync(join(dir, hook), 0o755);
      }
    }
    plainGit(root, ['config', 'core.hooksPath', join(markers, 'hooks')]);
    write(root, '.git/extra.cfg', `[core]\n\tfsmonitor = ${script('fsmonitor', 'exit 1\n')}\n`);
    plainGit(root, ['config', 'include.path', 'extra.cfg']);
    plainGit(root, ['config', 'commit.gpgSign', 'true']);
    plainGit(root, ['config', 'gpg.program', script('gpg', 'exit 1\n')]);
    plainGit(root, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
    plainGit(root, ['config', 'user.name', 'Repo Config Name']);
    plainGit(root, ['config', 'user.email', 'private@example.com']);
    plainGit(root, ['config', 'core.splitIndex', 'true']);

    write(root, 'index.html', 'v2\n');
    const repo = open(root);
    const { commit } = await saveFiles(repo, root, ['index.html']);
    expect(readdirSync(markers).filter((n) => n.endsWith('.ran'))).toEqual([]);
    const raw = plainGit(root, ['-c', 'core.fsmonitor=false', 'cat-file', 'commit', commit]);
    expect(raw).not.toContain('gpgsig');
    expect(raw).not.toContain('encoding');
    expect(raw).toContain('author Draft Tide <draft-tide@localhost>');
    expect(raw).not.toContain('private@example.com');

    // Controls: the user's own Git runs each of them.
    plainGit(root, ['update-ref', 'refs/heads/control', commit]);
    expect(existsSync(join(markers, 'hook-reference-transaction.ran'))).toBe(true);
    plainGit(root, ['status']);
    expect(existsSync(join(markers, 'fsmonitor.ran'))).toBe(true);
    const tree = plainGit(root, ['rev-parse', `${commit}^{tree}`]).trim();
    const encoded = plainGit(root, ['commit-tree', tree, '-m', 'control']).trim();
    expect(plainGit(root, ['cat-file', 'commit', encoded])).toContain('encoding ISO-8859-1');
    expect(plainGitResult(root, ['commit', '--allow-empty', '-m', 'control']).status).not.toBe(0);
    expect(existsSync(join(markers, 'gpg.ran'))).toBe(true);
    plainGit(root, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'control']);
    expect(existsSync(join(markers, 'hook-pre-commit.ran'))).toBe(true);
  });
});

describe('Git invocations', () => {
  it('runs plumbing only, every call with the hardening and explicit dirs', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    write(root, 'index.html', 'v2\n');
    const repo = open(root);
    gitTrace.enabled = true;
    gitTrace.argv.length = 0;
    try {
      const { commit, tree } = await saveFiles(repo, root, ['index.html']);
      await repo.readCommits([commit]);
      await repo.firstParentLine(commit, { skip: 0, limit: 5 });
      await repo.listTree(commit);
      await repo.lookupPath(tree, 'index.html');
      await repo.isAncestor(commit, commit);
      const op = newOp();
      await repo.prepareIndexFromTree(op, tree);
      await repo.discardPreparedIndex(op);
      for await (const _ of repo.streamBlob((await repo.listTree(tree)).entries[0]?.oid as string)) {
        // drain
      }
    } finally {
      gitTrace.enabled = false;
    }
    const commands = new Set<string>();
    for (const argv of gitTrace.argv) {
      expect(argv[1]).toBe(`--git-dir=${join(root, '.git')}`);
      expect(argv[2]).toBe(`--work-tree=${root}`);
      expect(argv.slice(3, 3 + HARDENING.length)).toEqual(HARDENING);
      commands.add(argv[3 + HARDENING.length] as string);
    }
    expect([...commands].sort()).toEqual([
      'cat-file',
      'commit-tree',
      'for-each-ref',
      'hash-object',
      'ls-files',
      'ls-tree',
      'merge-base',
      'read-tree',
      'rev-list',
      // Publish reads HEAD under the lock (M1-05).
      'symbolic-ref',
      'update-index',
      'update-ref',
      'write-tree',
    ]);
  });
});
