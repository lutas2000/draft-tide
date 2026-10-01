// Scope and capture end to end, on real Git and a real filesystem: the
// adapters wired the way the Engine wires them (M1-02). Nothing here may write
// into the design folder or its `.git`.
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRoot, createStagingArea, openWorkspace } from '@draft-tide/adapter-filesystem';
import {
  DtError,
  PROJECT_CONFIG_FILE,
  ProjectId,
  serializeProjectConfig,
  type ProjectConfig,
} from '@draft-tide/contracts';
import {
  assertUsable,
  captureScope,
  reviewScope,
  type Capture,
  type CaptureOptions,
  type Workspace,
} from '@draft-tide/core';
import { createScratchGitDir, openGitRepo } from '@draft-tide/git-backend';
import { afterAll, describe, expect, it } from 'vitest';
// Fixture helpers shared with git-backend's own tests.
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  gitRuntime,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';

const rt = gitRuntime();
const dataDir = tempDir('dt-data-');
afterAll(cleanupTempDirs);

const onWindows = process.platform === 'win32';
const onLinux = process.platform === 'linux';

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

async function setup(root: string, wrap: (ws: Workspace) => Workspace = (ws) => ws): Promise<CaptureOptions> {
  const canonical = await canonicalRoot(root, { appDataDir: dataDir });
  const repo = openGitRepo(rt, canonical);
  const probe = await repo.probe();
  return {
    repo,
    workspace: wrap(openWorkspace(canonical)),
    staging: await createStagingArea(dataDir, randomUUID(), randomUUID()),
    probe,
    retryDelayMs: () => 1,
  };
}

async function capture(root: string, wrap?: (ws: Workspace) => Workspace): Promise<Capture> {
  const options = await setup(root, wrap);
  assertUsable(options.probe);
  return captureScope(options);
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

const hashObject = (root: string, rel: string) => plainGit(root, ['hash-object', '--no-filters', '--', rel]).trim();

// What the user's own Git reports. `git status` may refresh `.git/index`
// itself, so it runs before the byte-level snapshot is taken.
const gitStatus = (root: string) => plainGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);

describe('capture on a real design folder', () => {
  it('captures every file in scope byte for byte and writes nothing to the folder', async () => {
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
    adopt(root, { excludeDirNames: ['drafts'] });
    write(root, 'new page.html', '<p>new</p>\n');
    write(root, 'emoji 🎨.svg', '<svg/>\n');
    write(root, 'café.html', 'nfd name\n');
    write(root, 'img/hero-copy.png', png);
    write(root, '.env', 'SECRET=1\n');
    write(root, 'node_modules/pkg/index.js', 'x');
    write(root, '.DS_Store', 'x');
    write(root, 'dist/bundle.js', 'x');
    write(root, 'drafts/wip.html', 'x');
    write(root, 'index.html', '<!doctype html><h1>edited</h1>\n');
    rmSync(join(root, 'old.html'));
    const status = gitStatus(root);
    const before = digestTree(root);

    const cap = await capture(root);

    expect(digestTree(root)).toEqual(before);
    expect(gitStatus(root)).toBe(status);
    const paths = cap.files.map((f) => f.path);
    const nfdName = paths.find((p) => p.endsWith('.html') && p.normalize('NFC') === 'café.html');
    expect(nfdName).toBeDefined();
    expect([...paths].sort()).toEqual(
      [
        '.drafttide.json',
        '.env.production',
        '.gitignore',
        nfdName as string,
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
    expect(cap.deleted).toEqual(['old.html']);
    expect(cap.attempts).toBe(1);
    for (const f of cap.files) {
      expect(f.oid, f.path).toBe(hashObject(root, f.path));
      if (f.staged) expect(readFileSync(f.staged)).toEqual(readFileSync(join(root, f.path)));
    }
    const byPath = new Map(cap.files.map((f) => [f.path, f]));
    // Unchanged tracked content, and a copy of it, are already in Git.
    expect(byPath.get('img/hero.png')?.staged).toBeNull();
    expect(byPath.get('img/hero-copy.png')?.staged).toBeNull();
    expect(byPath.get('index.html')?.staged).not.toBeNull();
    expect(byPath.get('new page.html')?.staged).not.toBeNull();
    // CRLF kept as is.
    expect(byPath.get('notes/windows.txt')?.oid).toBe(hashObject(root, 'notes/windows.txt'));
    expect(cap.newBytes).toBeLessThan(cap.totalBytes);
  });

  it('stages content Git holds only as a dangling object', async () => {
    const root = committedRepo();
    adopt(root);
    write(root, 'new.html', 'only in a dangling blob\n');
    plainGit(root, ['hash-object', '-w', '--', 'new.html']);
    expect((await capture(root)).files.find((f) => f.path === 'new.html')?.staged).not.toBeNull();
  });

  it.skipIf(onWindows)('records the executable bit, including a change of only that bit', async () => {
    const root = committedRepo({ 'run.sh': '#!/bin/sh\necho hi\n' });
    adopt(root);
    chmodSync(join(root, 'run.sh'), 0o755);
    const run = (await capture(root)).files.find((f) => f.path === 'run.sh');
    expect(run).toMatchObject({ mode: '100755', staged: null });
  });

  it('works in a fresh repo with no commits', async () => {
    const root = tempDir('dt-fresh-');
    plainGit(root, ['init', '--quiet']);
    write(root, 'index.html', 'x');
    adopt(root);
    const cap = await capture(root);
    expect(cap.files.map((f) => f.path)).toEqual([PROJECT_CONFIG_FILE, 'index.html']);
    expect(cap.files.every((f) => f.staged !== null)).toBe(true);
  });

  it('retries while a writer is active, then saves what it settled on', async () => {
    const root = committedRepo({ 'index.html': 'v0' });
    adopt(root);
    let attempt = 0;
    const cap = await capture(root, (ws) => ({
      ...ws,
      hash: async (path, expected, signal) => {
        const r = await ws.hash(path, expected, signal);
        // Writes once during the first attempt's first pass.
        if (path === 'index.html' && attempt++ === 0) writeFileSync(join(root, 'index.html'), 'v1 from the writer');
        return r;
      },
    }));
    expect(cap.attempts).toBe(2);
    expect(cap.files.find((f) => f.path === 'index.html')?.oid).toBe(hashObject(root, 'index.html'));
  });

  it('fails with SOURCE_BUSY when a writer never stops, leaving no staged files', async () => {
    const root = committedRepo({ 'index.html': 'v0' });
    adopt(root);
    let n = 0;
    const options = await setup(root, (ws) => ({
      ...ws,
      hash: async (path, expected, signal) => {
        const r = await ws.hash(path, expected, signal);
        if (path === 'index.html') writeFileSync(join(root, 'index.html'), `v${++n}`);
        return r;
      },
    }));
    const err = await refusal(captureScope(options));
    expect(err.code).toBe('SOURCE_BUSY');
    expect(err.details['changed']).toEqual(['index.html']);
    expect(readdirSync(options.staging.dir)).toEqual([]);
  });

  it('stops before staging when the disk is too full, and cleans up', async () => {
    const root = committedRepo();
    adopt(root);
    write(root, 'big.bin', randomBytes(1024 * 1024));
    const options = await setup(root);
    options.staging.space = () => Promise.resolve({ volume: 'elsewhere', availableBytes: 1024 });
    const err = await refusal(captureScope(options));
    expect(err.code).toBe('INSUFFICIENT_DISK_SPACE');
    expect(err.details).toMatchObject({ volume: 'app-data', availableBytes: 1024 });
    expect(readdirSync(options.staging.dir)).toEqual([]);
  });

  it('needs the project settings file and refuses an unsafe one', async () => {
    const root = committedRepo();
    expect((await refusal(capture(root))).details['reason']).toBe('missing');
    writeFileSync(join(root, PROJECT_CONFIG_FILE), JSON.stringify({ schemaVersion: 9 }));
    const err = await refusal(capture(root));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.details).toMatchObject({ reason: 'newer-schema', requiresNewerApp: true });
  });
});

describe('what capture refuses', () => {
  it.skipIf(onWindows)('never reads through a parent folder swapped for a symlink', async () => {
    const outside = tempDir('dt-outside-');
    write(outside, 'secret.txt', 'OUTSIDE SECRET\n');
    const root = committedRepo({ 'a/secret.txt': 'inside\n', 'index.html': 'x' });
    adopt(root);
    rmSync(join(root, 'a'), { recursive: true });
    symlinkSync(join(outside), join(root, 'a'));
    const options = await setup(root);
    const err = await refusal(captureScope(options));
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(err.details['entries']).toEqual([
      // The link itself is a new, unsupported entry; the tracked path behind it is refused.
      { path: 'a', kind: 'symlink' },
      { path: 'a/secret.txt', kind: 'parent-not-directory' },
    ]);
    const leaked = plainGit(root, ['hash-object', '--stdin'], 'OUTSIDE SECRET\n').trim();
    expect(() => plainGit(root, ['cat-file', '-e', leaked])).toThrow();
    expect(existsSync(join(options.staging.dir, 'attempt-1'))).toBe(false);
  });

  it.skipIf(onWindows)('refuses symlinks, tracked or new, instead of skipping them', async () => {
    const root = committedRepo({ 'index.html': 'x' });
    adopt(root);
    symlinkSync('index.html', join(root, 'tracked-link'));
    plainGit(root, ['add', 'tracked-link']);
    plainGit(root, ['commit', '--quiet', '-m', 'link']);
    symlinkSync('/etc/hosts', join(root, 'new-link'));
    const err = await refusal(capture(root));
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(err.details['entries']).toEqual([
      { path: 'new-link', kind: 'symlink' },
      { path: 'tracked-link', kind: 'symlink' },
    ]);
  });

  it('refuses an untracked nested repository', async () => {
    const root = committedRepo();
    adopt(root);
    plainGit(root, ['init', '--quiet', 'vendor/lib']);
    write(root, 'vendor/lib/x.js', 'x');
    const err = await refusal(capture(root));
    expect(err.code).toBe('REPO_UNSUPPORTED');
    expect(err.details['reason']).toBe('nested-repo');
  });

  it('refuses skip-worktree entries and an unresolved merge', async () => {
    const root = committedRepo({ 'a.txt': 'base\n', 'b.txt': 'b\n' });
    adopt(root);
    plainGit(root, ['update-index', '--skip-worktree', 'b.txt']);
    expect((await refusal(capture(root))).details['reason']).toBe('index-flags');
    plainGit(root, ['update-index', '--no-skip-worktree', 'b.txt']);

    plainGit(root, ['add', PROJECT_CONFIG_FILE]);
    plainGit(root, ['commit', '--quiet', '-m', 'adopt']);
    plainGit(root, ['checkout', '--quiet', '-b', 'side']);
    write(root, 'a.txt', 'side\n');
    plainGit(root, ['commit', '--quiet', '-am', 'side']);
    plainGit(root, ['checkout', '--quiet', 'main']);
    write(root, 'a.txt', 'main\n');
    plainGit(root, ['commit', '--quiet', '-am', 'main']);
    expect(() => plainGit(root, ['merge', '--quiet', 'side'])).toThrow();
    const err = await refusal(capture(root));
    expect(err.code).toBe('REPO_BUSY');
    expect(err.retryable).toBe(true);
    expect(err.details['reason']).toBe('merge-in-progress');
  });

  it('refuses a detached HEAD before reading anything', async () => {
    const root = committedRepo();
    adopt(root);
    plainGit(root, ['checkout', '--quiet', '--detach']);
    expect((await refusal(capture(root))).details['reason']).toBe('detached-head');
  });

  it('refuses LFS and filters without running them; a control shows the filter is live', async () => {
    const root = committedRepo({ 'index.html': 'x' });
    adopt(root);
    const marker = join(tempDir('dt-marker-'), 'filter-ran');
    plainGit(root, ['config', 'filter.evil.clean', `sh -c 'touch "${marker.replaceAll('\\', '/')}"; cat'`]);
    write(root, '.gitattributes', '*.html filter=evil\n');
    const err = await refusal(capture(root));
    expect(err.code).toBe('REPO_UNSUPPORTED');
    expect(err.details['reason']).toBe('attribute-filter');
    expect(existsSync(marker)).toBe(false);
    // Control (the filter runs through sh): the user's own `git add` runs it.
    if (!onWindows) {
      plainGit(root, ['add', 'index.html']);
      expect(existsSync(marker)).toBe(true);
    }

    const lfs = committedRepo({ 'img.psd': 'x' });
    adopt(lfs);
    write(lfs, '.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    expect((await refusal(capture(lfs))).details['reason']).toBe('git-lfs');
  });

  it('refuses explicit line-ending conversion on CRLF files only', async () => {
    const crlf = 'a\r\nb\r\n';
    const strict = committedRepo({ 'a.txt': crlf, '.gitattributes': '*.txt text\n' });
    adopt(strict);
    const err = await refusal(capture(strict));
    expect(err.details['reason']).toBe('line-ending-normalization');
    expect(err.details['blockers']).toEqual([
      {
        code: 'REPO_UNSUPPORTED',
        reason: 'line-ending-normalization',
        details: { count: 1, sample: ['a.txt'] },
      },
    ]);
    // `text=auto` and core.autocrlf keep CRLF already in the index.
    const auto = committedRepo({ 'a.txt': crlf, '.gitattributes': '* text=auto\n' });
    adopt(auto);
    expect((await capture(auto)).files.find((f) => f.path === 'a.txt')?.oid).toBe(hashObject(auto, 'a.txt'));
    const autocrlf = committedRepo({ 'a.txt': crlf });
    plainGit(autocrlf, ['config', 'core.autocrlf', 'true']);
    adopt(autocrlf);
    await expect(capture(autocrlf)).resolves.toBeTruthy();
  });

  it.skipIf(!onLinux)('refuses paths that would collide on case-insensitive disks', async () => {
    const root = committedRepo({ 'Logo.png': 'a' });
    adopt(root);
    write(root, 'logo.png', 'b');
    const err = await refusal(capture(root));
    expect(err.details['entries']).toEqual([
      { path: 'Logo.png', kind: 'path-collision' },
      { path: 'logo.png', kind: 'path-collision' },
    ]);
  });

  it.skipIf(!onLinux)('refuses names that are not UTF-8', async () => {
    const root = committedRepo();
    adopt(root);
    writeFileSync(Buffer.concat([Buffer.from(`${root}/x-`), Buffer.from([0xff]), Buffer.from('.txt')]), 'x');
    const err = await refusal(capture(root));
    expect(err.details['entries']).toEqual([{ path: 'x-�.txt', kind: 'non-utf8-name' }]);
  });
});

describe.skipIf(onWindows)('hostile repository (each setting with a control that fires)', () => {
  it('runs none of the programs a repo configures', async () => {
    const root = committedRepo({ 'index.html': 'x' });
    adopt(root);
    write(root, 'new.html', 'y');
    const markers = tempDir('dt-markers-');
    const script = (name: string, body = '') => {
      const p = join(markers, `${name}.sh`);
      writeFileSync(p, `#!/bin/sh\necho "$@" > "${join(markers, `${name}.ran`)}"\n${body}`, { mode: 0o755 });
      return p;
    };
    // Hooks in .git/hooks and in a core.hooksPath directory.
    for (const dir of [join(root, '.git', 'hooks'), join(markers, 'hooks')]) {
      for (const hook of ['pre-commit', 'post-checkout', 'reference-transaction', 'post-index-change']) {
        write(dir, hook, `#!/bin/sh\ntouch "${join(markers, `hook-${hook}.ran`)}"\n`);
        chmodSync(join(dir, hook), 0o755);
      }
    }
    plainGit(root, ['config', 'core.hooksPath', join(markers, 'hooks')]);
    // fsmonitor brought in through include.path.
    write(root, '.git/extra.cfg', `[core]\n\tfsmonitor = ${script('fsmonitor', 'exit 1\n')}\n`);
    plainGit(root, ['config', 'include.path', 'extra.cfg']);
    for (const [key, name] of [
      ['core.pager', 'pager'],
      ['core.editor', 'editor'],
      ['core.sshCommand', 'ssh'],
      ['core.askPass', 'askpass'],
      ['diff.external', 'diff'],
      ['gpg.program', 'gpg'],
      ['credential.helper', 'credential'],
      ['core.alternateRefsCommand', 'alternate-refs'],
    ]) {
      plainGit(root, ['config', key as string, script(name as string)]);
    }
    plainGit(root, ['config', 'commit.gpgSign', 'true']);

    const review = await reviewScope(openGitRepo(rt, root), openWorkspace(root), null);
    expect(review.probe.warnings.map((w) => w.reason)).toEqual(['dangerous-config', 'hooks-present']);
    const cap = await capture(root);
    expect(cap.files.map((f) => f.path)).toContain('new.html');
    expect(readdirSync(markers).filter((n) => n.endsWith('.ran'))).toEqual([]);

    // Controls: the user's own Git does run them.
    plainGit(root, ['status']);
    expect(existsSync(join(markers, 'fsmonitor.ran'))).toBe(true);
    plainGit(root, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'control']);
    expect(existsSync(join(markers, 'hook-pre-commit.ran'))).toBe(true);
  });

  it('ignores a repo excludesFile that would hide every new file', async () => {
    const root = committedRepo();
    adopt(root);
    write(root, 'new.html', 'x');
    write(root, '.git/hide-all', '*\n');
    plainGit(root, ['config', 'core.excludesFile', join(root, '.git', 'hide-all')]);
    expect(plainGit(root, ['ls-files', '--others', '--exclude-standard'])).toBe('');
    expect((await capture(root)).files.map((f) => f.path)).toContain('new.html');
  });
});

describe('scope review', () => {
  it('shows a plain folder’s scope before it is bound, through a scratch git dir', async () => {
    const root = tempDir('dt-plain-');
    write(root, 'index.html', '<h1>home</h1>');
    write(root, 'pages/about.html', '<h1>about</h1>');
    write(root, 'css/site.css', 'x');
    write(root, 'img/big.png', randomBytes(64 * 1024));
    write(root, '.env', 'SECRET=1');
    write(root, 'node_modules/x/index.js', 'x');
    write(root, '.gitignore', 'build/\n');
    write(root, 'build/out.js', 'x');
    write(root, 'drafts/wip.html', 'x');
    const before = digestTree(root);
    const scratch = await createScratchGitDir(rt, join(dataDir, 'tmp'));
    try {
      const repo = openGitRepo(rt, root, { scratchGitDir: scratch.gitDir });
      const review = await reviewScope(repo, openWorkspace(root), {
        entryFiles: ['index.html', 'drafts/wip.html', 'missing.html'],
        excludeDirNames: ['drafts'],
        excludeFilePatterns: [],
      });
      expect(review.probe.hasRepo).toBe(false);
      expect(review.blockers).toEqual([]);
      expect(review.included.files).toBe(5);
      expect(review.included.largest[0]).toEqual({ path: 'img/big.png', size: 64 * 1024 });
      expect(review.excluded.sample).toEqual(['.env', 'build/', 'drafts/', 'node_modules/']);
      expect(review.excludedByDefaults.sample).toEqual(['.env', 'node_modules/']);
      expect(review.entryFiles).toEqual([
        { path: 'index.html', status: 'included' },
        { path: 'drafts/wip.html', status: 'excluded' },
        { path: 'missing.html', status: 'missing' },
      ]);
      expect(review.entryCandidates).toEqual(['index.html', 'pages/about.html']);
    } finally {
      await scratch.remove();
    }
    expect(digestTree(root)).toEqual(before);
  });

  it('lists every blocker of an existing repo at once', async () => {
    const root = committedRepo({
      'a.txt': 'a\r\n',
      'b.md': 'b',
      'img.psd': 'x',
      '.gitattributes': '*.txt text\n*.psd filter=lfs\n',
    });
    plainGit(root, ['update-index', '--skip-worktree', 'b.md']);
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), plainGit(root, ['rev-parse', 'HEAD']));
    const review = await reviewScope(openGitRepo(rt, root), openWorkspace(root), null);
    expect(review.blockers.map((b) => `${b.code}:${b.reason}`)).toEqual([
      'REPO_BUSY:merge-in-progress',
      'REPO_UNSUPPORTED:index-flags',
      'REPO_UNSUPPORTED:git-lfs',
      'REPO_UNSUPPORTED:line-ending-normalization',
    ]);
  });

  it('does not scan a folder whose repo form is unsupported', async () => {
    const root = committedRepo();
    plainGit(root, ['checkout', '--quiet', '--detach']);
    const review = await reviewScope(openGitRepo(rt, root), openWorkspace(root), null);
    expect(review.blockers.map((b) => b.reason)).toEqual(['detached-head']);
    expect(review.included.files).toBe(0);
  });
});
