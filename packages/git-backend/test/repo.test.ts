import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EXCLUDE_DIR_NAMES, DEFAULT_EXCLUDE_FILE_PATTERNS, DtError } from '@draft-tide/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HARDENING,
  createScratchGitDir,
  gitEnvironment,
  gitTrace,
  gitVersion,
  openGitRepo,
  runGit,
  type GitRuntime,
} from '../src/index.ts';
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  gitRuntime,
  onWindows,
  plainGit,
  tempDir,
  write,
} from './helpers.ts';

const rt = gitRuntime();
afterAll(cleanupTempDirs);

const DEFAULTS = { dirNames: DEFAULT_EXCLUDE_DIR_NAMES, filePatterns: DEFAULT_EXCLUDE_FILE_PATTERNS };
const NONE = { dirNames: [], filePatterns: [] };

async function dtError(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

describe('listings', () => {
  it('lists the index with modes, ids and flags', async () => {
    const root = committedRepo({ 'a.txt': 'a', 'sub/b.txt': 'b', 'run.sh': '#!/bin/sh\n' });
    plainGit(root, ['update-index', '--chmod=+x', 'run.sh']);
    plainGit(root, ['update-index', '--skip-worktree', 'sub/b.txt']);
    plainGit(root, ['update-index', '--assume-unchanged', 'a.txt']);
    const oid = plainGit(root, ['hash-object', '-w', '--stdin'], 'target').trim();
    plainGit(root, ['update-index', '--add', '--cacheinfo', `120000,${oid},link`]);
    plainGit(root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${plainGit(root, ['rev-parse', 'HEAD']).trim()},mod`,
    ]);
    const { entries, nonUtf8 } = await openGitRepo(rt, root).listIndex();
    expect(nonUtf8).toEqual([]);
    expect(entries.map((e) => [e.path, e.mode, e.stage, e.flag])).toEqual([
      ['a.txt', '100644', 0, 'assume-unchanged'],
      ['link', '120000', 0, null],
      ['mod', '160000', 0, null],
      ['run.sh', '100755', 0, null],
      ['sub/b.txt', '100644', 0, 'skip-worktree'],
    ]);
    expect(entries.find((e) => e.path === 'link')?.oid).toBe(oid);
  });

  it('lists untracked files with .gitignore, info/exclude and the rules applied', async () => {
    const root = committedRepo({ 'index.html': 'x', '.gitignore': 'build/\n*.bak\n' });
    for (const rel of [
      'new.css',
      'pages/定價 頁.html',
      'emoji-🎨.svg',
      'build/out.js',
      'old.bak',
      '.env',
      '.env.local',
      'node_modules/pkg/i.js',
      'deep/node_modules/x.js',
      'keys/id_rsa',
      '.DS_Store',
      'drafts/wip.html',
      'local-only.txt',
    ]) {
      write(root, rel, rel);
    }
    write(root, '.git/info/exclude', 'local-only.txt\n');
    const repo = openGitRepo(rt, root);
    const r = await repo.listUntracked({
      dirNames: [...DEFAULTS.dirNames, 'drafts'],
      filePatterns: DEFAULTS.filePatterns,
    });
    expect(r.files.sort()).toEqual(['emoji-🎨.svg', 'new.css', 'pages/定價 頁.html'].sort());
    expect(r.nestedRepos).toEqual([]);

    const excluded = await repo.listExcluded(DEFAULTS, { standard: true });
    expect(excluded.entries.sort()).toEqual(
      [
        '.DS_Store',
        '.env',
        '.env.local',
        'build/',
        'deep/node_modules/',
        'keys/id_rsa',
        'local-only.txt',
        'node_modules/',
        'old.bak',
      ].sort(),
    );
    const byDefaults = await repo.listExcluded(DEFAULTS, { standard: false });
    expect(byDefaults.entries).not.toContain('build/');
    expect(byDefaults.entries).not.toContain('old.bak');
    expect(byDefaults.entries).toContain('.env');
    expect(await repo.listExcluded(NONE, { standard: false })).toEqual({ entries: [], nonUtf8: [] });
  });

  it('reports an untracked nested repository instead of its files', async () => {
    const root = committedRepo();
    const nested = join(root, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    plainGit(nested, ['init', '--quiet']);
    write(nested, 'x.js', 'x');
    const r = await openGitRepo(rt, root).listUntracked(DEFAULTS);
    expect(r.nestedRepos).toEqual(['vendor/lib/']);
    expect(r.files).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('reports names that are not UTF-8', async () => {
    const root = committedRepo();
    writeFileSync(Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]), 'x');
    const r = await openGitRepo(rt, root).listUntracked(DEFAULTS);
    expect(r.files).toEqual([]);
    expect(r.nonUtf8).toEqual(['bad-��.txt']);
  });

  it('reads attributes from .gitattributes without running filters', async () => {
    const root = committedRepo({
      '.gitattributes':
        '*.psd filter=lfs diff=lfs -text\n*.txt text\n*.bat eol=crlf\n*.c ident\n*.u16 working-tree-encoding=UTF-16\n',
    });
    const attrs = await openGitRepo(rt, root).checkAttributes(['a.psd', 'b.txt', 'c.bat', 'd.c', 'e.u16', 'f.html']);
    expect(attrs.get('a.psd')).toMatchObject({ filter: 'lfs', text: 'unset' });
    expect(attrs.get('b.txt')).toMatchObject({ text: 'set', eol: 'unspecified' });
    expect(attrs.get('c.bat')).toMatchObject({ eol: 'crlf' });
    expect(attrs.get('d.c')).toMatchObject({ ident: 'set' });
    expect(attrs.get('e.u16')).toMatchObject({ workingTreeEncoding: 'UTF-16' });
    expect(attrs.get('f.html')).toEqual({
      filter: 'unspecified',
      text: 'unspecified',
      eol: 'unspecified',
      ident: 'unspecified',
      workingTreeEncoding: 'unspecified',
    });
    expect((await openGitRepo(rt, root).checkAttributes([])).size).toBe(0);
  });

  it('finds which blobs the object store already has', async () => {
    const root = committedRepo({ 'a.txt': 'hello\n' });
    const present = plainGit(root, ['hash-object', '--stdin'], 'hello\n').trim();
    const absent = plainGit(root, ['hash-object', '--stdin'], 'never written\n').trim();
    const tree = plainGit(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const found = await openGitRepo(rt, root).existingBlobs([present, absent, tree, present]);
    expect([...found]).toEqual([present]);
    await expect(openGitRepo(rt, root).existingBlobs(['HEAD'])).rejects.toThrow('invalid object id');
  });

  it('measures the object store, loose objects and packs, writing nothing', async () => {
    // Random bytes don't compress, loose or packed, so the store holds at
    // least this much on every platform (Windows Git counts bytes, not disk
    // blocks, in whole KiB).
    const root = committedRepo({ 'a.txt': 'hello\n', 'big.bin': randomBytes(64 * 1024) });
    const repo = openGitRepo(rt, root);
    const loose = await repo.objectStoreSize();
    expect(loose).toBeGreaterThanOrEqual(64 * 1024);
    expect(loose % 1024).toBe(0);
    plainGit(root, ['gc', '--quiet']);
    const packed = await repo.objectStoreSize();
    expect(packed).toBeGreaterThanOrEqual(64 * 1024);
    const before = digestTree(join(root, '.git'));
    await repo.objectStoreSize();
    expect(digestTree(join(root, '.git'))).toEqual(before);
  });

  it('writes nothing while listing', async () => {
    const root = committedRepo({ 'a.txt': 'a', '.gitattributes': '*.txt text\n' });
    write(root, 'a.txt', 'changed');
    write(root, 'new.txt', 'new');
    const before = digestTree(join(root, '.git'));
    const repo = openGitRepo(rt, root);
    await repo.listIndex();
    await repo.listUntracked(DEFAULTS);
    await repo.listExcluded(DEFAULTS, { standard: true });
    await repo.checkAttributes(['a.txt', 'new.txt']);
    await repo.existingBlobs(['0'.repeat(40)]);
    await repo.probe();
    expect(digestTree(join(root, '.git'))).toEqual(before);
  });

  it('lists a folder without .git through a scratch git dir, writing nothing into it', async () => {
    const root = tempDir();
    write(root, 'index.html', 'x');
    write(root, 'css/site.css', 'y');
    write(root, '.gitignore', '*.log\n');
    write(root, 'debug.log', 'z');
    const scratch = await createScratchGitDir(rt, join(tempDir(), 'tmp'));
    try {
      const repo = openGitRepo(rt, root, { scratchGitDir: scratch.gitDir });
      expect((await repo.probe()).hasRepo).toBe(false);
      expect((await repo.listIndex()).entries).toEqual([]);
      expect((await repo.listUntracked(DEFAULTS)).files.sort()).toEqual(['.gitignore', 'css/site.css', 'index.html']);
      expect((await repo.listExcluded(DEFAULTS, { standard: true })).entries).toEqual(['debug.log']);
      expect(existsSync(join(root, '.git'))).toBe(false);
    } finally {
      await scratch.remove();
    }
    expect(existsSync(scratch.gitDir)).toBe(false);
  });
});

describe('hardening (each with a control that shows the setting is live)', () => {
  it('ignores a core.excludesFile that hides every new file', async () => {
    const root = committedRepo();
    write(root, 'new.html', 'x');
    write(root, '.git/hide-all', '*\n');
    plainGit(root, ['config', 'core.excludesFile', join(root, '.git', 'hide-all')]);
    // Control: plain Git honors it and sees no new files.
    expect(plainGit(root, ['ls-files', '--others', '--exclude-standard'])).toBe('');
    expect((await openGitRepo(rt, root).listUntracked(DEFAULTS)).files).toEqual(['new.html']);
  });

  it('ignores a core.attributesFile that adds filters', async () => {
    const root = committedRepo();
    write(root, '.git/evil-attributes', '* filter=evil\n');
    plainGit(root, ['config', 'core.attributesFile', join(root, '.git', 'evil-attributes')]);
    expect(plainGit(root, ['check-attr', 'filter', 'index.html'])).toContain('filter: evil');
    expect((await openGitRepo(rt, root).checkAttributes(['index.html'])).get('index.html')?.filter).toBe('unspecified');
  });

  it('builds the environment from scratch', async () => {
    const root = committedRepo();
    const elsewhere = committedRepo({ 'other.txt': 'other' });
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = join(elsewhere, '.git');
      process.env['GIT_WORK_TREE'] = elsewhere;
      process.env['GIT_INDEX_FILE'] = join(elsewhere, '.git', 'index');
      process.env['GIT_CONFIG_PARAMETERS'] = "'core.excludesfile'='/nonexistent'";
      process.env['GIT_OBJECT_DIRECTORY'] = join(elsewhere, '.git', 'objects');
      const { entries } = await openGitRepo(rt, root).listIndex();
      expect(entries.map((e) => e.path)).toEqual(['index.html']);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    }
    const env = gitEnvironment(rt);
    expect(
      Object.keys(env)
        .filter((k) => k.startsWith('GIT_'))
        .sort(),
    ).toEqual(
      [
        'GIT_ADVICE',
        'GIT_ALLOW_PROTOCOL',
        'GIT_ATTR_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_GRAFT_FILE',
        'GIT_NO_LAZY_FETCH',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_OPTIONAL_LOCKS',
        'GIT_PAGER',
        'GIT_TERMINAL_PROMPT',
      ].sort(),
    );
    expect(env['HOME']).toBe(rt.homeDir);
  });

  it('passes every local call through the hardening, with explicit git and work-tree dirs', async () => {
    const root = committedRepo();
    gitTrace.enabled = true;
    gitTrace.argv.length = 0;
    try {
      const repo = openGitRepo(rt, root);
      await repo.probe();
      await repo.listIndex();
      await repo.listUntracked(DEFAULTS);
      await repo.checkAttributes(['index.html']);
      await repo.existingBlobs(['0'.repeat(40)]);
    } finally {
      gitTrace.enabled = false;
    }
    expect(gitTrace.argv.length).toBeGreaterThan(4);
    const commands = new Set<string>();
    for (const argv of gitTrace.argv) {
      expect(argv[1]).toBe(`--git-dir=${join(root, '.git')}`);
      expect(argv[2]).toBe(`--work-tree=${root}`);
      expect(argv.slice(3, 3 + HARDENING.length)).toEqual(HARDENING);
      commands.add(argv[3 + HARDENING.length] as string);
    }
    // Plumbing only.
    expect([...commands].sort()).toEqual([
      'cat-file',
      'check-attr',
      'config',
      'for-each-ref',
      'ls-files',
      'symbolic-ref',
    ]);
  });
});

describe('runGit', () => {
  it('reports a Git that cannot be started', async () => {
    const bad: GitRuntime = { ...rt, gitPath: join(tempDir(), onWindows ? 'nope.exe' : 'nope') };
    const err = await dtError(runGit(bad, ['--version'], tempDir()));
    expect(err.code).toBe('GIT_FAILED');
    expect(err.details['reason']).toBe('git-unavailable');
    expect(await gitVersion(bad)).toBeNull();
    expect(await gitVersion(rt)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reports a failing command with its exit code', async () => {
    const err = await dtError(runGit(rt, ['--git-dir=/nonexistent', 'ls-files'], tempDir()));
    expect(err.code).toBe('GIT_FAILED');
    expect(err.details).toMatchObject({ subcommand: 'ls-files' });
  });

  it('bounds buffered output', async () => {
    const root = committedRepo();
    const err = await dtError(
      runGit(rt, [`--git-dir=${join(root, '.git')}`, 'cat-file', '-p', 'HEAD'], root, { maxOutputBytes: 10 }),
    );
    expect(err.code).toBe('RESOURCE_BUDGET_EXCEEDED');
  });

  it.skipIf(onWindows)('stops a hung Git on abort and on timeout', async () => {
    const dir = tempDir();
    const fake = join(dir, 'git');
    writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const hung: GitRuntime = { ...rt, gitPath: fake };
    const ac = new AbortController();
    const running = runGit(hung, ['ls-files'], dir, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('cancelled')), 50);
    await expect(running).rejects.toThrow('cancelled');
    const err = await dtError(runGit(hung, ['ls-files'], dir, { timeoutMs: 50 }));
    expect(err.code).toBe('GIT_FAILED');
    expect(err.details['reason']).toBe('timeout');
    expect(err.retryable).toBe(true);
  });
});
