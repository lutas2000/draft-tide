import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { DtError } from './errors.ts';

// Git runtime the spike uses. Product code must only ever use the bundled Git;
// the system Git fallback exists so the storage spike can compare both.
export interface GitRuntime {
  gitPath: string;
  execPath: string | null;
  source: 'bundled' | 'dugite-dev' | 'system';
  homeDir: string;
}

export function resolveGitRuntime(dataDir: string): GitRuntime {
  const homeDir = join(dataDir, 'runtime', 'git-home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  const bundledRoot = process.env['DRAFT_TIDE_GIT_ROOT'];
  if (bundledRoot) {
    return {
      gitPath: join(bundledRoot, 'bin', 'git'),
      execPath: join(bundledRoot, 'libexec', 'git-core'),
      source: 'bundled',
      homeDir,
    };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Packaged layout: Resources/companion/*.mjs next to Resources/git.
  const packagedRoot = resolve(here, '..', 'git');
  if (existsSync(join(packagedRoot, 'bin', 'git'))) {
    return { gitPath: join(packagedRoot, 'bin', 'git'), execPath: join(packagedRoot, 'libexec', 'git-core'), source: 'bundled', homeDir };
  }
  if (process.env['M0_USE_SYSTEM_GIT'] !== '1') {
    const dugiteRoot = resolve(here, '..', '..', 'node_modules', 'dugite', 'git');
    if (existsSync(join(dugiteRoot, 'bin', 'git'))) {
      return {
        gitPath: join(dugiteRoot, 'bin', 'git'),
        execPath: join(dugiteRoot, 'libexec', 'git-core'),
        source: 'dugite-dev',
        homeDir,
      };
    }
  }
  return { gitPath: '/usr/bin/git', execPath: null, source: 'system', homeDir };
}

// Every invocation gets these. Hooks, attribute files, fsmonitor, auto GC /
// maintenance, signing and non-file transports are all disabled, whatever the
// parent environment or user config says.
const HARDENING_ARGS = [
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-pager',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.fsync=objects,reference',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'transfer.fsckObjects=true',
];

const IDENTITY = { name: 'Draft Tide', email: 'draft-tide@localhost' };

export function sanitizedEnv(rt: GitRuntime, extra: Record<string, string> = {}): Record<string, string> {
  // Built from scratch: nothing from process.env leaks in (GIT_DIR,
  // GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, GIT_EXTERNAL_DIFF...).
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
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
  };
  if (rt.execPath) env['GIT_EXEC_PATH'] = rt.execPath;
  return { ...env, ...extra };
}

export interface GitRunOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  allowExitCodes?: number[];
}

export interface GitResult {
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
  exitCode: number;
}

// A Git handle bound to one bare repository. There is no passthrough: callers
// use named operations built on top of this in the store.
export class Git {
  readonly rt: GitRuntime;
  readonly gitDir: string;

  constructor(rt: GitRuntime, gitDir: string) {
    this.rt = rt;
    this.gitDir = gitDir;
  }

  private argv(args: string[]): string[] {
    return [`--git-dir=${this.gitDir}`, ...HARDENING_ARGS, ...args];
  }

  spawn(args: string[], env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    return spawn(this.rt.gitPath, this.argv(args), {
      cwd: existsSync(this.gitDir) ? this.gitDir : dirname(this.gitDir),
      env: sanitizedEnv(this.rt, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }

  run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const maxOut = opts.maxOutputBytes ?? 64 * 1024 * 1024;
    const allowed = new Set([0, ...(opts.allowExitCodes ?? [])]);
    return new Promise((resolvePromise, reject) => {
      const child = this.spawn(args, opts.env ?? {});
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxOut) {
          child.kill('SIGKILL');
          reject(new DtError('RESOURCE_BUDGET_EXCEEDED', 'git metadata output exceeded budget', { budget: 'git-metadata-output', subcommand: args[0] }));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (e) => reject(new DtError('GIT_FAILED', `failed to start git: ${e.message}`, { subcommand: args[0] })));
      child.on('close', (code) => {
        const stdoutBuffer = Buffer.concat(out);
        const result: GitResult = {
          stdout: stdoutBuffer.toString('utf8'),
          stdoutBuffer,
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code ?? -1,
        };
        if (allowed.has(result.exitCode)) resolvePromise(result);
        else reject(new DtError('GIT_FAILED', `git ${args[0]} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`, { subcommand: args[0], exitCode: result.exitCode }));
      });
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }
}

export async function gitVersion(rt: GitRuntime): Promise<string> {
  const g = new Git(rt, rt.homeDir);
  const r = await g.run(['version']);
  return r.stdout.trim();
}

// Streams blobs out of `git cat-file --batch` into caller-provided sinks
// without buffering whole files (bounded by one pipe chunk).
export class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending: { oid: string; sink: Writable; resolve: (n: number) => void; reject: (e: Error) => void } | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private state: 'header' | 'body' | 'trailer' = 'header';
  private remaining = 0;
  private size = 0;
  private closed = false;
  // True while the sink asked for backpressure. Buffered bytes (including the
  // blob's trailer) wait until it drains, so a read never resolves while
  // Git's stdout is still paused.
  private draining = false;

  constructor(git: Git) {
    this.child = git.spawn(['cat-file', '--batch']);
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.on('close', () => {
      this.closed = true;
      this.pending?.reject(new DtError('GIT_FAILED', 'cat-file exited'));
      this.pending = null;
    });
  }

  read(oid: string, sink: Writable): Promise<number> {
    if (!/^[0-9a-f]{40}$/.test(oid)) return Promise.reject(new DtError('GIT_FAILED', 'invalid object id'));
    if (this.pending || this.closed) return Promise.reject(new DtError('GIT_FAILED', 'blob reader busy or closed'));
    return new Promise((resolvePromise, reject) => {
      this.pending = { oid, sink, resolve: resolvePromise, reject };
      this.state = 'header';
      this.child.stdin.write(`${oid}\n`);
    });
  }

  private onData(chunk: Buffer): void {
    if (chunk.length) this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length && this.pending && !this.draining) {
      const p = this.pending;
      if (this.state === 'header') {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const header = this.buf.subarray(0, nl).toString('utf8');
        this.buf = this.buf.subarray(nl + 1);
        const parts = header.split(' ');
        if (parts[1] !== 'blob' || parts[0] !== p.oid) {
          this.pending = null;
          p.reject(new DtError('GIT_FAILED', `unexpected cat-file header: ${header}`));
          continue;
        }
        this.size = Number(parts[2]);
        this.remaining = this.size;
        this.state = this.remaining === 0 ? 'trailer' : 'body';
      } else if (this.state === 'body') {
        const take = Math.min(this.remaining, this.buf.length);
        const part = this.buf.subarray(0, take);
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (!p.sink.write(part)) {
          this.draining = true;
          this.child.stdout.pause();
          p.sink.once('drain', () => {
            this.draining = false;
            this.child.stdout.resume();
            this.onData(Buffer.alloc(0));
          });
        }
        if (this.remaining === 0) this.state = 'trailer';
      } else {
        this.buf = this.buf.subarray(1); // trailing LF
        this.pending = null;
        this.state = 'header';
        p.resolve(this.size);
      }
    }
  }

  close(): void {
    this.child.stdin.end();
  }
}
