import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// An ordinary, unhardened Git used the way a designer's tools, an engineer or
// an agent would: the ground truth for "does `git status` agree with us".
export const EXT_GIT = '/usr/bin/git';

export interface Work {
  dir: string;
  extHome: string;
  dataDir: string;
  gitHome: string;
  fresh(name: string): string;
}

export function makeWork(): Work {
  const base = process.env['SPIKE_WORK'] ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'dt-single-repo-'));
  const extHome = join(dir, 'ext-home');
  mkdirSync(extHome);
  writeFileSync(join(extHome, '.gitconfig'), '[user]\n\tname = Engineer\n\temail = engineer@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  return {
    dir,
    extHome,
    dataDir,
    gitHome: join(dir, 'git-home'),
    fresh(name: string) {
      const p = join(dir, `${name}-${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(p, { recursive: true });
      return p;
    },
  };
}

export function extEnv(w: Work, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: w.extHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(w.extHome, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    ...extra,
  };
}

export class Ext {
  readonly w: Work;
  constructor(w: Work) {
    this.w = w;
  }
  git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
    return execFileSync(EXT_GIT, args, { cwd, env: extEnv(this.w, extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  // Use this (never the sync variants) for anything that talks to the in-process
  // test server: a blocked event loop would deadlock the server.
  async gitAsync(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<string> {
    const { stdout } = await promisify(execFile)(EXT_GIT, args, { cwd, env: extEnv(this.w, extra), encoding: 'utf8', timeout: 60_000 });
    return stdout;
  }
  try(cwd: string, args: string[], extra: Record<string, string> = {}): { ok: boolean; out: string; err: string } {
    const r = spawnSync(EXT_GIT, args, { cwd, env: extEnv(this.w, extra), encoding: 'utf8' });
    return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
  }
  status(cwd: string): string {
    return this.git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  }
  commitAll(cwd: string, msg: string): string {
    this.git(cwd, ['add', '-A']);
    this.git(cwd, ['commit', '-q', '-m', msg]);
    return this.git(cwd, ['rev-parse', 'HEAD']).trim();
  }
  head(cwd: string): string {
    return this.git(cwd, ['rev-parse', 'HEAD']).trim();
  }
  lsTree(cwd: string, rev = 'HEAD'): string[] {
    return this.git(cwd, ['ls-tree', '-r', '--name-only', rev]).trim().split('\n').filter(Boolean).sort();
  }
}

export function put(root: string, rel: string, content: string | Buffer, mode?: number): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode !== undefined) chmodSync(p, mode);
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

export function del(root: string, rel: string): void {
  rmSync(join(root, rel), { recursive: true, force: true });
}

export function link(root: string, rel: string, target: string): void {
  symlinkSync(target, join(root, rel));
}

export function randomBytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

// A plausible design project committed by "someone else" (an engineer).
export function designFixture(w: Work, ext: Ext, name: string): string {
  const root = w.fresh(name);
  ext.git(root, ['init', '-q', '-b', 'main']);
  put(root, 'index.html', '<!doctype html>\n<link rel="stylesheet" href="styles.css">\n<h1>Aurora</h1>\n<script src="app.js"></script>\n');
  put(root, 'styles.css', 'body { margin: 0; font-family: system-ui; }\n');
  put(root, 'app.js', 'console.log("aurora");\n');
  put(root, 'notes.txt', 'first notes\n');
  put(root, 'assets/logo.png', randomBytes(4096, 7));
  put(root, 'assets/hero.jpg', randomBytes(20000, 11));
  put(root, 'scripts/run.sh', '#!/bin/sh\necho run\n', 0o755);
  put(root, '.gitignore', 'node_modules/\ndist/\n*.log\n');
  ext.commitAll(root, 'engineer: initial design');
  put(root, 'styles.css', 'body { margin: 0; font-family: system-ui; color: #123; }\n');
  ext.commitAll(root, 'engineer: tweak colors');
  return root;
}

export function addNoise(root: string): void {
  put(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  put(root, 'dist/bundle.js', '/* built */\n');
  put(root, 'debug.log', 'log\n');
  put(root, '.env', 'SECRET=1\n');
  put(root, '.DS_Store', randomBytes(64, 3));
}

export function dirSize(p: string): number {
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : statSync(f).size;
  }
  return n;
}

export function walkFiles(p: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    if (e.isDirectory()) out.push(...walkFiles(f));
    else out.push(f);
  }
  return out;
}

// Mini test runner.
export interface CheckResult {
  section: string;
  name: string;
  ok: boolean;
  note?: string;
  ms: number;
}

export class Suite {
  readonly results: CheckResult[] = [];
  readonly observations: Record<string, unknown> = {};
  private section = '';

  begin(section: string): void {
    this.section = section;
    console.log(`\n## ${section}`);
  }

  async check(name: string, fn: () => Promise<void | string>): Promise<void> {
    const t = performance.now();
    try {
      const note = await fn();
      const ms = performance.now() - t;
      this.results.push({ section: this.section, name, ok: true, ...(note ? { note } : {}), ms });
      console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
    } catch (e) {
      const ms = performance.now() - t;
      const msg = e instanceof Error ? e.message : String(e);
      this.results.push({ section: this.section, name, ok: false, note: msg, ms });
      console.log(`  FAIL ${name}\n       ${msg.split('\n').join('\n       ')}`);
    }
  }

  observe(key: string, value: unknown): void {
    this.observations[key] = value;
    console.log(`  obs  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function eq<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function rejectsWith(fn: () => Promise<unknown>, code: string, what: string): Promise<{ details: Record<string, unknown>; message: string }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
    if (err.code === code) return { details: err.details ?? {}, message: err.message ?? '' };
    throw new Error(`${what}: expected error ${code}, got ${err.code ?? 'other'}: ${err.message}`);
  }
  throw new Error(`${what}: expected error ${code}, but it succeeded`);
}
