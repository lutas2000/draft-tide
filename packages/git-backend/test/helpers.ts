import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findGitOnPath, type GitRuntime } from '../src/index.ts';

const created: string[] = [];

export function tempDir(prefix = 'dt-git-'): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(d);
  return d;
}

export function cleanupTempDirs(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function gitRuntime(): GitRuntime {
  const gitPath = findGitOnPath();
  if (!gitPath) throw new Error('these tests need git on PATH (or DRAFT_TIDE_GIT)');
  return { gitPath, execPath: null, homeDir: tempDir('dt-home-') };
}

// The user's own Git, without Draft Tide's hardening: what an engineer or a
// plain `git status` would do. It builds fixtures and serves as the control
// in hostile-repo tests. It never reads the developer's real config, and it
// runs no automatic maintenance: after a commit, Git would otherwise start
// `git maintenance run --auto` in the background, whose lock files appear in
// `.git` while a test checks that nothing there changed.
let plainConfig: string | null = null;
export function plainGitEnv(): NodeJS.ProcessEnv {
  if (!plainConfig) {
    const dir = tempDir('dt-plain-');
    plainConfig = join(dir, 'gitconfig');
    writeFileSync(
      plainConfig,
      '[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[protocol "file"]\n\tallow = always\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n',
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: plainConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && !k.startsWith('GIT_CONFIG')) delete env[k];
  return env;
}

export function plainGit(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, {
    cwd,
    env: plainGitEnv(),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// The user's own Git where failure is the expected outcome (a control, or a
// command that must be blocked).
export function plainGitResult(
  cwd: string,
  args: string[],
  input?: string | Buffer,
): { status: number; stderr: string } {
  const r = spawnSync('git', args, { cwd, env: plainGitEnv(), input, encoding: 'utf8' });
  return { status: r.status ?? -1, stderr: r.stderr };
}

// What `git status` reports, as the user's Git sees it: empty means no staged,
// unstaged or untracked changes.
export function gitStatus(root: string): string {
  return plainGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}

export function write(root: string, rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

// A repo with one commit.
export function committedRepo(files: Record<string, string | Buffer> = { 'index.html': '<h1>v1</h1>\n' }): string {
  const root = tempDir('dt-repo-');
  plainGit(root, ['init', '--quiet']);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  plainGit(root, ['add', '-A']);
  plainGit(root, ['commit', '--quiet', '-m', 'first']);
  return root;
}

// Every file under dir with its bytes' hash: proves a read-only operation
// wrote nothing (the index, HEAD, config, refs, objects…).
export function digestTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const st = statSync(abs);
        out[relative(dir, abs)] =
          `${createHash('sha256').update(readFileSync(abs)).digest('hex')} ${st.mode.toString(8)} ${st.mtimeMs}`;
      } else out[relative(dir, abs)] = 'other';
    }
  };
  walk(dir);
  return out;
}

export function gitVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
}

export const onWindows = process.platform === 'win32';

// A file:// URL for a local repo, on every platform.
export function fileUrl(path: string): string {
  const p = path.replaceAll('\\', '/');
  return p.startsWith('/') ? `file://${p}` : `file:///${p}`;
}
