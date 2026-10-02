// Run this yourself against a throwaway GitHub repo. It is NOT part of `verify`
// because it needs a real token and writes to a real remote.
//
//   DT_GITHUB_URL=https://github.com/<owner>/<test-repo>.git \
//   DT_GITHUB_TOKEN=<token with push access to that repo> \
//   [DT_GITHUB_USER=x-access-token] \
//   node src/github-check.ts
//
// What it does (and only this):
//   1. makes a temporary design folder, adopts it, saves a version
//   2. pushes it to a NEW branch named dt-spike-<random> (never an existing one)
//   3. fetches that branch back through an ephemeral git dir and compares the tip
//   4. opens the project from the remote into a second folder (clone path)
//   5. deletes the branch it created
// The repo must already have a default branch: the first push into an empty
// repo makes the pushed branch the default, and GitHub refuses to delete it.
// The token is read from the environment, handed to Git through an askpass
// script in a 0700 temp dir, and never placed in argv, .git/config or the URL.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitRuntime } from './git.ts';
import { DesignRepo } from './repo.ts';
import { cloneFromRemote, deleteRemoteBranch, fetchRemote, pushBranch } from './sync.ts';

const url = process.env['DT_GITHUB_URL'];
const token = process.env['DT_GITHUB_TOKEN'];
const username = process.env['DT_GITHUB_USER'] ?? 'x-access-token';
if (!url || !token || !url.startsWith('https://')) {
  console.error('set DT_GITHUB_URL (https://...) and DT_GITHUB_TOKEN; see the header of this file');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'dt-github-check-'));
const rt = resolveGitRuntime(join(work, 'git-home'));
const cred = { username, token };
const binding = { url, branch: `dt-spike-${randomBytes(4).toString('hex')}` };
const step = (m: string) => console.log(`- ${m}`);

try {
  const root = join(work, 'design');
  writeFileSync(join(work, 'placeholder'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<h1>draft tide github check</h1>\n');
  const repo = await DesignRepo.adopt(rt, join(work, 'data'), root, { name: 'GitHub check', entryFiles: ['index.html'] });
  const saved = await repo.save({ name: 'check' });
  step(`saved ${saved.commit.slice(0, 8)}`);
  const pushed = await pushBranch(repo, binding, cred);
  step(`pushed to new branch ${binding.branch} (created=${pushed.created})`);
  const tip = await fetchRemote(repo, binding, cred);
  step(`fetched remote tip ${tip?.slice(0, 8)} — ${tip === saved.commit ? 'matches' : 'MISMATCH'}`);
  const clone = await cloneFromRemote(rt, join(work, 'data-b'), join(work, 'clone'), binding, cred);
  step(`opened the project from the remote: ${(await clone.history()).length} version(s)`);
  await deleteRemoteBranch(repo, binding, cred);
  step(`deleted ${binding.branch}`);
  console.log('\nOK: push, fetch, clone and branch delete worked with askpass credentials');
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`\nFAILED: ${err.code ?? ''} ${err.message ?? String(e)}`);
  console.error(`(a branch named ${binding.branch} may have been left on the remote; delete it by hand if so)`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
