import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DtError } from './errors.ts';

export interface GitRuntime {
  gitPath: string;
  execPath: string | null;
  source: string;
  homeDir: string;
}

// The spike prefers the full dugite Git from the M0 spike: the trimmed M0 build
// has no git-remote-https, so it cannot talk to a remote at all (a finding).
export function resolveGitRuntime(homeDir: string): GitRuntime {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const here = dirname(fileURLToPath(import.meta.url));
  const forced = process.env['DRAFT_TIDE_GIT_ROOT'];
  if (forced === 'system') return { gitPath: '/usr/bin/git', execPath: null, source: 'system', homeDir };
  const candidates = [forced, resolve(here, '../../m0/core/node_modules/dugite/git'), resolve(here, '../../m0/core/build/git')];
  for (const root of candidates) {
    if (root && existsSync(join(root, 'bin', 'git'))) {
      return { gitPath: join(root, 'bin', 'git'), execPath: join(root, 'libexec', 'git-core'), source: root, homeDir };
    }
  }
  return { gitPath: '/usr/bin/git', execPath: null, source: 'system', homeDir };
}

// Every local invocation gets these. They sit on the command line, so they
// outrank whatever the repository's own .git/config says: hooks, fsmonitor,
// external attribute/ignore files, line-ending conversion, signing, auto GC.
export const HARDENING = [
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-pager',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.splitIndex=false',
  '-c', 'core.fsync=objects,reference',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'protocol.allow=never',
  '-c', 'transfer.fsckObjects=true',
];

export const DEFAULT_IDENTITY = { name: 'Draft Tide', email: 'draft-tide@localhost' };

export function sanitizedEnv(rt: GitRuntime, extra: Record<string, string> = {}): Record<string, string> {
  // Built from scratch: nothing from process.env leaks in.
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: rt.homeDir,
    XDG_CONFIG_HOME: join(rt.homeDir, '.config'),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: DEFAULT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: DEFAULT_IDENTITY.email,
    GIT_COMMITTER_NAME: DEFAULT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: DEFAULT_IDENTITY.email,
  };
  if (rt.execPath) env['GIT_EXEC_PATH'] = rt.execPath;
  return { ...env, ...extra };
}

export interface GitResult {
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  allowExitCodes?: number[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

// Test instrumentation: lets the suite prove a secret never reached argv or
// any captured output.
export const trace: { enabled: boolean; argv: string[][]; output: string[] } = { enabled: false, argv: [], output: [] };

export function spawnGit(rt: GitRuntime, argv: string[], cwd: string, env: Record<string, string>, opts: RunOptions = {}): Promise<GitResult> {
  const maxOut = opts.maxOutputBytes ?? 64 * 1024 * 1024;
  const allowed = new Set([0, ...(opts.allowExitCodes ?? [])]);
  return new Promise((resolvePromise, reject) => {
    if (trace.enabled) trace.argv.push([rt.gitPath, ...argv]);
    const child = spawn(rt.gitPath, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new DtError('GIT_FAILED', `git ${argv.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} timed out`, {}, true));
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new DtError('RESOURCE_BUDGET_EXCEEDED', 'git output exceeded budget', { budget: 'git-metadata-output' }));
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DtError('GIT_FAILED', `failed to start git: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(out);
      const result: GitResult = { stdout: stdoutBuffer.toString('utf8'), stdoutBuffer, stderr: Buffer.concat(err).toString('utf8'), exitCode: code ?? -1 };
      if (trace.enabled) trace.output.push(result.stdout, result.stderr);
      if (allowed.has(result.exitCode)) resolvePromise(result);
      else {
        const sub = argv.find((a, i) => !a.startsWith('-') && !argv[i - 1]?.startsWith('-c') && !a.includes('=')) ?? '';
        reject(new DtError('GIT_FAILED', `git ${sub} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 600)}`, { subcommand: sub, exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) }));
      }
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// A Git handle on one user repository: explicit --git-dir and --work-tree (no
// discovery, no cwd tricks), hardened on the command line. There is no
// passthrough: callers use named operations built on top of run().
export class RepoGit {
  readonly rt: GitRuntime;
  readonly root: string;
  readonly gitDir: string;
  readonly hardened: boolean;

  constructor(rt: GitRuntime, root: string, opts: { hardened?: boolean } = {}) {
    this.rt = rt;
    this.root = root;
    this.gitDir = join(root, '.git');
    this.hardened = opts.hardened ?? true;
  }

  run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const argv = [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, ...(this.hardened ? HARDENING : []), ...args];
    return spawnGit(this.rt, argv, this.root, sanitizedEnv(this.rt, opts.env ?? {}), opts);
  }
}
