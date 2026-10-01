import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DtError, type RepoBlocker } from '@draft-tide/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { isBranchRef, openGitRepo } from '../src/index.ts';
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  fileUrl,
  gitRuntime,
  gitVersion,
  onWindows,
  plainGit,
  tempDir,
  write,
} from './helpers.ts';

const rt = gitRuntime();
afterAll(cleanupTempDirs);

const probe = (root: string) => openGitRepo(rt, root).probe();
const reasons = (blockers: RepoBlocker[]) => blockers.map((b) => `${b.code}:${b.reason}`);

describe('probeRepo', () => {
  it('describes a plain folder that would be initialized', async () => {
    const root = tempDir();
    const p = await probe(root);
    expect(p).toMatchObject({ hasRepo: false, headRef: null, tip: null, blockers: [] });
    expect(p.trustExecutableBit).toBe(!onWindows);
  });

  it('refuses a plain folder inside another repo', async () => {
    const outer = committedRepo();
    mkdirSync(join(outer, 'design'));
    const p = await probe(join(outer, 'design'));
    expect(reasons(p.blockers)).toEqual(['REPO_UNSUPPORTED:inside-another-repo']);
  });

  it('reads the branch and tip of an existing repo, and an unborn branch', async () => {
    const root = committedRepo();
    const tip = plainGit(root, ['rev-parse', 'HEAD']).trim();
    expect(await probe(root)).toMatchObject({ hasRepo: true, headRef: 'refs/heads/main', branch: 'main', tip });

    const fresh = tempDir();
    plainGit(fresh, ['init', '--quiet', '--initial-branch=設計']);
    expect(await probe(fresh)).toMatchObject({ hasRepo: true, branch: '設計', tip: null, blockers: [] });
  });

  it('writes nothing into the repo', async () => {
    const root = committedRepo();
    const before = digestTree(join(root, '.git'));
    await probe(root);
    expect(digestTree(join(root, '.git'))).toEqual(before);
  });

  it('refuses a detached HEAD', async () => {
    const root = committedRepo();
    plainGit(root, ['checkout', '--quiet', '--detach']);
    expect(reasons((await probe(root)).blockers)).toEqual(['REPO_UNSUPPORTED:detached-head']);
  });

  it('refuses a linked worktree', async () => {
    const root = committedRepo();
    const linked = join(tempDir(), 'linked');
    plainGit(root, ['worktree', 'add', '--quiet', '-b', 'other', linked]);
    expect(reasons((await probe(linked)).blockers)).toEqual(['REPO_UNSUPPORTED:linked-worktree-or-submodule']);
    // The main worktree with a linked one is fine.
    expect((await probe(root)).blockers).toEqual([]);
  });

  it.skipIf(onWindows)('refuses a .git that is a symlink', async () => {
    const real = committedRepo();
    const root = tempDir();
    symlinkSync(join(real, '.git'), join(root, '.git'));
    expect(reasons((await probe(root)).blockers)).toEqual(['REPO_UNSUPPORTED:dot-git-symlink']);
  });

  it('refuses a shallow clone', async () => {
    const origin = committedRepo();
    write(origin, 'two.html', '2');
    plainGit(origin, ['add', '-A']);
    plainGit(origin, ['commit', '--quiet', '-m', 'second']);
    const clone = join(tempDir(), 'clone');
    plainGit(tempDir(), ['clone', '--quiet', '--depth', '1', fileUrl(origin), clone]);
    expect(reasons((await probe(clone)).blockers)).toEqual(['REPO_UNSUPPORTED:shallow-clone']);
  });

  it('refuses sha256 repos', async () => {
    const root = tempDir();
    plainGit(root, ['init', '--quiet', '--object-format=sha256']);
    expect(reasons((await probe(root)).blockers)).toContain('REPO_UNSUPPORTED:sha256-object-format');
  });

  it.skipIf(gitVersion()[0] < 2 || (gitVersion()[0] === 2 && gitVersion()[1] < 45))('refuses reftable', async () => {
    const root = tempDir();
    plainGit(root, ['init', '--quiet', '--ref-format=reftable']);
    expect(reasons((await probe(root)).blockers)).toContain('REPO_UNSUPPORTED:reftable');
  });

  it.each([
    [
      'partial clone',
      [
        ['core.repositoryformatversion', '1'],
        ['extensions.partialClone', 'origin'],
      ],
      'partial-clone',
    ],
    ['promisor remote', [['remote.origin.promisor', 'true']], 'partial-clone'],
    ['sparse checkout', [['core.sparseCheckout', 'true']], 'sparse-checkout'],
    ['sparse index', [['index.sparse', 'yes']], 'sparse-checkout'],
    ['bare', [['core.bare', 'true']], 'bare-repo'],
    [
      'unknown extension',
      [
        ['core.repositoryformatversion', '1'],
        ['extensions.futureThing', 'x'],
      ],
      'unknown-repo-format',
    ],
    ['future format', [['core.repositoryformatversion', '2']], 'unknown-repo-format'],
  ])('refuses a %s', async (_name, settings, reason) => {
    const root = committedRepo();
    for (const [k, v] of settings) plainGit(root, ['config', k as string, v as string]);
    expect(reasons((await probe(root)).blockers)).toContain(`REPO_UNSUPPORTED:${reason}`);
  });

  it.each([
    ['MERGE_HEAD', 'merge-in-progress'],
    ['CHERRY_PICK_HEAD', 'cherry-pick-in-progress'],
    ['REVERT_HEAD', 'revert-in-progress'],
    ['BISECT_LOG', 'bisect-in-progress'],
    ['rebase-merge/', 'rebase-in-progress'],
    ['rebase-apply/', 'rebase-in-progress'],
    ['sequencer/', 'sequencer-in-progress'],
  ])('reports %s as busy (retryable)', async (marker, reason) => {
    const root = committedRepo();
    const abs = join(root, '.git', marker);
    if (marker.endsWith('/')) mkdirSync(abs);
    else writeFileSync(abs, plainGit(root, ['rev-parse', 'HEAD']));
    const p = await probe(root);
    expect(reasons(p.blockers)).toEqual([`REPO_BUSY:${reason}`]);
    expect(p.tip).not.toBeNull();
  });

  it('reports a real merge conflict as busy', async () => {
    const root = committedRepo({ 'a.txt': 'base\n' });
    plainGit(root, ['checkout', '--quiet', '-b', 'side']);
    write(root, 'a.txt', 'side\n');
    plainGit(root, ['commit', '--quiet', '-am', 'side']);
    plainGit(root, ['checkout', '--quiet', 'main']);
    write(root, 'a.txt', 'main\n');
    plainGit(root, ['commit', '--quiet', '-am', 'main']);
    expect(() => plainGit(root, ['merge', '--quiet', 'side'])).toThrow();
    expect(reasons((await probe(root)).blockers)).toEqual(['REPO_BUSY:merge-in-progress']);
    const index = await openGitRepo(rt, root).listIndex();
    expect(index.entries.filter((e) => e.path === 'a.txt').map((e) => e.stage)).toEqual([1, 2, 3]);
  });

  it('warns about hooks and settings that could run programs, without refusing', async () => {
    const root = committedRepo();
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    plainGit(root, ['config', 'core.fsmonitor', '/tmp/evil']);
    plainGit(root, ['config', 'url.https://evil.example/.insteadOf', 'https://github.com/']);
    const p = await probe(root);
    expect(p.blockers).toEqual([]);
    expect(p.warnings).toEqual([
      { reason: 'dangerous-config', details: { keys: ['core.fsmonitor', 'url.https://evil.example/.insteadof'] } },
      { reason: 'hooks-present', details: { hooks: ['pre-commit'] } },
    ]);
  });

  it('follows core.fileMode for the executable bit', async () => {
    const root = committedRepo();
    plainGit(root, ['config', 'core.fileMode', 'false']);
    expect((await probe(root)).trustExecutableBit).toBe(false);
  });

  it('fails clearly when the folder is gone', async () => {
    const root = tempDir();
    rmSync(root, { recursive: true });
    await expect(probe(root)).rejects.toSatisfy((e) => e instanceof DtError && e.code === 'LOCAL_ROOT_UNAVAILABLE');
  });
});

describe('isBranchRef', () => {
  it.each(['refs/heads/main', 'refs/heads/feature/x', 'refs/heads/設計', 'refs/heads/a-b_c.d'])('accepts %s', (r) =>
    expect(isBranchRef(r)).toBe(true),
  );
  it.each([
    'refs/remotes/origin/main',
    'refs/heads/',
    'refs/heads/a..b',
    'refs/heads/a.lock',
    'refs/heads/.hidden',
    'refs/heads/a//b',
    'refs/heads/a b',
    'refs/heads/a@{1}',
    'refs/heads/a\\b',
    'refs/heads/x.',
    'HEAD',
  ])('rejects %s', (r) => expect(isBranchRef(r)).toBe(false));
});
