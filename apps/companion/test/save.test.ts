// Saving versions end to end, on real Git and a real filesystem: the adapters
// and core wired the way the Engine wires them (M1-03). What the user's own
// Git sees afterwards is checked with plain Git, without Draft Tide's
// hardening (M1 plan §13.1).
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalRoot, createStagingArea, openWorkspace } from '@draft-tide/adapter-filesystem';
import {
  DRAFT_TIDE_IDENTITY,
  DtError,
  IsoTimestamp,
  OperationId,
  PROJECT_CONFIG_FILE,
  ProjectId,
  readCommitMetadata,
  serializeProjectConfig,
  type ProjectConfig,
} from '@draft-tide/contracts';
import { readHistory, saveSnapshot, type ProjectGit, type SaveOptions, type SavedSnapshot } from '@draft-tide/core';
import { openGitRepo } from '@draft-tide/git-backend';
import { afterAll, describe, expect, it } from 'vitest';
// Fixture helpers shared with git-backend's own tests.
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  fileUrl,
  gitRuntime,
  gitStatus,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';

const rt = gitRuntime();
const dataDir = tempDir('dt-data-');
afterAll(cleanupTempDirs);

const onWindows = process.platform === 'win32';
const clock = { nowIso: () => IsoTimestamp.parse(new Date().toISOString()) };

function adopt(root: string, over: Partial<ProjectConfig> = {}): ProjectConfig {
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId: ProjectId.parse(randomUUID()),
    name: 'Fixture',
    entryFiles: ['index.html'],
    excludeDirNames: [],
    excludeFilePatterns: [],
    ...over,
  };
  writeFileSync(join(root, PROJECT_CONFIG_FILE), serializeProjectConfig(config));
  return config;
}

async function save(
  root: string,
  extra: Partial<SaveOptions> & { wrap?: (repo: ProjectGit) => ProjectGit } = {},
): Promise<SavedSnapshot> {
  const { wrap = (r) => r, ...rest } = extra;
  const canonical = await canonicalRoot(root, { appDataDir: dataDir });
  const operationId = OperationId.parse(randomUUID());
  return saveSnapshot({
    repo: wrap(openGitRepo(rt, canonical)),
    workspace: openWorkspace(canonical),
    staging: await createStagingArea(dataDir, randomUUID(), operationId),
    operationId,
    origin: 'gui',
    identity: DRAFT_TIDE_IDENTITY,
    clock,
    retryDelayMs: () => 1,
    ...rest,
  });
}

async function refusal(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();
const blobCount = (root: string) =>
  plainGit(root, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)'])
    .split('\n')
    .filter((t) => t === 'blob').length;
// No change to tracked files, staged or not.
const trackedStatus = (root: string) => plainGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
const untracked = (root: string) =>
  plainGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3))
    .sort();
const fsck = (root: string) => plainGit(root, ['fsck', '--strict', '--no-dangling', '--no-progress']);
const operationsLeft = () =>
  readdirSync(join(dataDir, 'projects'), { recursive: true }).filter((p) => String(p).includes('attempt-'));

describe('saving a design folder', () => {
  it('saves every file byte for byte and leaves the user’s Git clean and untouched', async () => {
    const png = randomBytes(200 * 1024);
    const root = committedRepo({
      'index.html': '<!doctype html><link rel=stylesheet href=css/site.css>\n',
      'css/site.css': 'body{margin:0}\n',
      'js/app.js': 'console.log(1)\n',
      'img/hero.png': png,
      'fonts/brand.woff2': randomBytes(32 * 1024),
      'notes/windows.txt': 'line one\r\nline two\r\n',
      '頁面/定價.html': '<h1>定價</h1>\n',
      '.env.production': 'TRACKED=1\n',
      '.gitignore': 'dist/\n.drafttide.json\n',
      'old.html': 'to be removed\n',
    });
    // The user's own Git state, which a save must leave alone.
    write(root, 'index.html', 'stashed work\n');
    plainGit(root, ['stash', 'push', '--quiet', '-m', 'wip']);
    plainGit(root, ['branch', 'feature']);
    plainGit(root, ['tag', 'v1']);
    plainGit(root, ['tag', '-a', 'v1-annotated', '-m', 'release']);
    plainGit(root, ['pack-refs', '--all']);
    plainGit(root, ['config', 'custom.key', 'value']);
    write(root, '.git/hooks/post-commit', '#!/bin/sh\ntouch "$GIT_DIR/../hook-ran"\n');
    if (!onWindows) chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
    write(root, '.git/info/exclude', 'local-only.txt\n');
    const userTip = head(root);
    const refs = () => plainGit(root, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n');
    const otherRefs = refs().filter((r) => !r.startsWith('refs/heads/main '));
    const stashes = plainGit(root, ['stash', 'list']);
    const kept = ['config', 'packed-refs', 'info/exclude', 'hooks/post-commit'].map((f) => [
      f,
      readFileSync(join(root, '.git', f)),
    ]);

    adopt(root, { excludeDirNames: ['drafts'] });
    write(root, 'new page.html', '<p>new</p>\n');
    write(root, 'emoji 🎨.svg', '<svg/>\n');
    write(root, 'cafe\u0301.html', 'nfd name\n');
    write(root, 'img/hero-copy.png', png);
    write(root, '.env', 'SECRET=1\n');
    write(root, 'node_modules/pkg/index.js', 'x');
    write(root, '.DS_Store', 'x');
    write(root, 'dist/bundle.js', 'x');
    write(root, 'drafts/wip.html', 'x');
    write(root, 'local-only.txt', 'x');
    write(root, 'index.html', '<!doctype html><h1>edited</h1>\n');
    rmSync(join(root, 'old.html'));

    const saved = await save(root, { name: 'First pass' });

    expect(saved).toMatchObject({ kind: 'baseline', parent: userTip, branch: 'main', attempts: 1 });
    expect(head(root)).toBe(saved.commit);
    const files = plainGit(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
    const nfd = files.find((p) => p.normalize('NFC') === 'caf\u00e9.html') as string;
    expect(files.sort()).toEqual(
      [
        '.drafttide.json',
        '.env.production',
        '.gitignore',
        nfd,
        'css/site.css',
        'emoji 🎨.svg',
        'fonts/brand.woff2',
        'img/hero-copy.png',
        'img/hero.png',
        'index.html',
        'js/app.js',
        'new page.html',
        'notes/windows.txt',
        '頁面/定價.html',
      ].sort(),
    );
    // Raw bytes, CRLF included: each entry is the working file's unfiltered blob.
    for (const f of files) {
      expect(plainGit(root, ['rev-parse', `HEAD:${f}`]).trim(), f).toBe(
        plainGit(root, ['hash-object', '--no-filters', '--', f]).trim(),
      );
    }
    // What the user's Git sees: nothing changed, only the excluded files are
    // untracked, and the repo is sound.
    expect(trackedStatus(root)).toBe('');
    expect(untracked(root)).toEqual(['.DS_Store', '.env', 'drafts/wip.html', 'node_modules/pkg/index.js']);
    expect(fsck(root)).toBe('');
    // The commit Draft Tide made.
    const message = plainGit(root, ['log', '-1', '--format=%B']);
    expect(message.split('\n')[0]).toBe('First pass');
    expect(readCommitMetadata(message.replace(/\n$/, ''))).toMatchObject({
      status: 'snapshot',
      metadata: { snapshotId: saved.snapshotId, kind: 'baseline', origin: 'gui', name: 'First pass' },
    });
    expect(plainGit(root, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Draft Tide <draft-tide@localhost>|Draft Tide <draft-tide@localhost>\n',
    );
    // Everything else as it was.
    expect(refs().filter((r) => !r.startsWith('refs/heads/main '))).toEqual(otherRefs);
    expect(plainGit(root, ['stash', 'list'])).toBe(stashes);
    for (const [f, bytes] of kept) expect(readFileSync(join(root, '.git', f as string)), f as string).toEqual(bytes);
    expect(existsSync(join(root, 'hook-ran'))).toBe(false);
    expect(readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.') || n === 'index.lock')).toEqual([]);
    expect(operationsLeft()).toEqual([]);
  });

  it('reuses content Git already has: an edit writes one blob, a copy or a rename none', async () => {
    const root = committedRepo({
      'index.html': 'v1\n',
      'css/site.css': 'body{}\n',
      'img/hero.png': randomBytes(64 * 1024),
    });
    adopt(root);
    await save(root);
    const blobs = blobCount(root);

    write(root, 'index.html', 'v2\n');
    const edit = await save(root);
    expect(edit).toMatchObject({ kind: 'manual', newObjects: 1, newBytes: 3 });
    expect(blobCount(root)).toBe(blobs + 1);

    copyFileSync(join(root, 'img/hero.png'), join(root, 'img/hero-2x.png'));
    renameSync(join(root, 'css/site.css'), join(root, 'css/main.css'));
    const moved = await save(root);
    expect(moved).toMatchObject({ newObjects: 0, newBytes: 0 });
    expect(blobCount(root)).toBe(blobs + 1);
    expect(trackedStatus(root)).toBe('');
    expect(fsck(root)).toBe('');
  });

  it('refuses a save that changes nothing, leaving every byte in .git as it was', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    const saved = await save(root);
    gitStatus(root); // lets the user's Git refresh its index first
    // Bytes and modes. Git refreshes the mtime of an object it is asked to
    // write again (write-tree), so it can't be pruned meanwhile.
    const contents = () =>
      Object.fromEntries(Object.entries(digestTree(join(root, '.git'))).map(([k, v]) => [k, v.split(' ').slice(0, 2)]));
    const before = contents();
    const err = await refusal(save(root, { name: 'Same again' }));
    expect(err.code).toBe('NO_CHANGES');
    expect(err.details).toEqual({ commit: saved.commit });
    expect(contents()).toEqual(before);
    expect(operationsLeft()).toEqual([]);
  });

  it('starts a new folder on main, with no hooks', async () => {
    const root = tempDir('dt-fresh-');
    write(root, 'index.html', '<h1>hello</h1>\n');
    write(root, 'img/logo.png', randomBytes(1024));
    const canonical = await canonicalRoot(root, { appDataDir: dataDir });
    await openGitRepo(rt, canonical).init();
    adopt(root);
    const saved = await save(root);
    expect(saved).toMatchObject({ kind: 'baseline', parent: null, branch: 'main' });
    expect(existsSync(join(root, '.git', 'hooks'))).toBe(false);
    expect(gitStatus(root)).toBe('');
    expect(fsck(root)).toBe('');
  });

  it.skipIf(onWindows)('records an executable-bit change as a version', async () => {
    const root = committedRepo({ 'run.sh': '#!/bin/sh\necho hi\n' });
    adopt(root);
    await save(root);
    chmodSync(join(root, 'run.sh'), 0o755);
    const saved = await save(root);
    expect(saved.newObjects).toBe(0);
    expect(plainGit(root, ['ls-tree', 'HEAD', 'run.sh']).split(' ')[0]).toBe('100755');
    expect(gitStatus(root)).toBe('');
  });

  it('keeps CRLF bytes under core.autocrlf and text=auto, with git status clean', async () => {
    const crlf = 'a\r\nb\r\n';
    const root = committedRepo({ 'a.txt': crlf, '.gitattributes': '* text=auto\n' });
    plainGit(root, ['config', 'core.autocrlf', 'true']);
    adopt(root);
    write(root, 'b.txt', 'c\r\nd\r\n');
    await save(root);
    expect(Buffer.from(plainGit(root, ['cat-file', 'blob', 'HEAD:b.txt']))).toEqual(Buffer.from('c\r\nd\r\n'));
    expect(gitStatus(root)).toBe('');
  });
});

describe('saving next to other Git users', () => {
  it('treats commits made by other tools as history and builds on them', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    const baseline = await save(root);
    write(root, 'README.md', 'by an engineer\n');
    plainGit(root, ['add', 'README.md']);
    plainGit(root, ['commit', '--quiet', '-m', 'Add a readme']);
    const external = head(root);
    write(root, 'index.html', 'v2\n');
    const next = await save(root, { origin: 'cli' });
    expect(next).toMatchObject({ parent: external, kind: 'agent-requested' });

    const history = await readHistory(openGitRepo(rt, root), next.commit, { skip: 0, limit: 10 });
    expect(history.map((h) => [h.title, h.snapshot?.kind ?? 'external'])).toEqual([
      ['Saved version (agent request)', 'agent-requested'],
      ['Add a readme', 'external'],
      ['Baseline', 'baseline'],
      ['first', 'external'],
    ]);
    expect(history[2]?.snapshot?.snapshotId).toBe(baseline.snapshotId);
  });

  it('rebuilds the same history from a plain clone: Git is the only record', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    await save(root);
    write(root, 'index.html', 'v2\n');
    const last = await save(root, { name: 'Second' });
    const clone = tempDir('dt-clone-');
    plainGit(clone, ['clone', '--quiet', fileUrl(root), '.']);
    const read = (dir: string) => readHistory(openGitRepo(rt, dir), head(dir), { skip: 0, limit: 50 });
    expect(await read(clone)).toEqual(await read(root));
    expect((await read(clone))[0]?.snapshot?.snapshotId).toBe(last.snapshotId);
    expect(readFileSync(join(clone, 'index.html'), 'utf8')).toBe('v2\n');
    expect(existsSync(join(clone, PROJECT_CONFIG_FILE))).toBe(true);
    expect(gitStatus(clone)).toBe('');
  });

  it('loses the race cleanly when someone commits during the save, and a retry builds on them', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    await save(root);
    write(root, 'index.html', 'designer\n');
    let theirs = '';
    const err = await refusal(
      save(root, {
        wrap: (repo) => ({
          ...repo,
          publish: (request) => {
            write(root, 'other.txt', 'engineer\n');
            plainGit(root, ['add', 'other.txt']);
            plainGit(root, ['commit', '--quiet', '-m', 'meanwhile']);
            theirs = head(root);
            return repo.publish(request);
          },
        }),
      }),
    );
    expect(err).toMatchObject({ code: 'HISTORY_CHANGED', retryable: true });
    expect(head(root)).toBe(theirs);
    expect(plainGit(root, ['show', 'HEAD:index.html'])).toBe('v1\n');
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('designer\n');

    const retried = await save(root);
    expect(retried.parent).toBe(theirs);
    expect(plainGit(root, ['ls-tree', '--name-only', 'HEAD']).split('\n')).toEqual(
      expect.arrayContaining(['index.html', 'other.txt']),
    );
    expect(trackedStatus(root)).toBe('');
  });

  it('fails with LOCKED while another Git holds the index, changing nothing', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    await save(root);
    write(root, 'index.html', 'v2\n');
    const tip = head(root);
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const err = await refusal(save(root, { lockWaitMs: 50 }));
    expect(err).toMatchObject({ code: 'LOCKED', retryable: true });
    expect(head(root)).toBe(tip);
    expect(operationsLeft()).toEqual([]);
    rmSync(join(root, '.git', 'index.lock'));
    expect((await save(root)).parent).toBe(tip);
  });

  it('refuses to save over a publish Draft Tide left unfinished', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    await save(root);
    write(root, 'index.html', 'v2\n');
    const stuck = randomUUID();
    writeFileSync(join(root, '.git', 'index.lock'), `draft-tide ${stuck}\n`);
    const err = await refusal(save(root));
    expect(err).toMatchObject({ code: 'RECOVERY_REQUIRED', details: { operationId: stuck } });
  });
});

describe.skipIf(onWindows)('hostile repository', () => {
  it('saves without running any hook or configured program', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    adopt(root);
    const markers = tempDir('dt-markers-');
    const script = (name: string) => {
      const p = join(markers, `${name}.sh`);
      writeFileSync(p, `#!/bin/sh\ntouch "${join(markers, `${name}.ran`)}"\nexit 1\n`, { mode: 0o755 });
      return p;
    };
    for (const dir of [join(root, '.git', 'hooks'), join(markers, 'hooks')]) {
      for (const hook of ['pre-commit', 'post-commit', 'reference-transaction', 'post-index-change']) {
        write(dir, hook, `#!/bin/sh\ntouch "${join(markers, `hook-${hook}.ran`)}"\n`);
        chmodSync(join(dir, hook), 0o755);
      }
    }
    plainGit(root, ['config', 'core.hooksPath', join(markers, 'hooks')]);
    write(root, '.git/extra.cfg', `[core]\n\tfsmonitor = ${script('fsmonitor')}\n`);
    plainGit(root, ['config', 'include.path', 'extra.cfg']);
    plainGit(root, ['config', 'commit.gpgSign', 'true']);
    plainGit(root, ['config', 'gpg.program', script('gpg')]);
    write(root, 'new.html', 'new\n');

    const saved = await save(root);
    expect(readdirSync(markers).filter((n) => n.endsWith('.ran'))).toEqual([]);
    expect(plainGit(root, ['cat-file', 'commit', saved.commit])).not.toContain('gpgsig');
    // Control: the user's own Git runs them.
    plainGit(root, ['status']);
    expect(existsSync(join(markers, 'fsmonitor.ran'))).toBe(true);
  });
});
