import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG_FILE, isSafeRelPath, type ProjectConfig } from './config.ts';
import type { RepoGit } from './git.ts';
import type { Blocker } from './probe.ts';

export type FileMode = '100644' | '100755';

export interface ScopeEntry {
  path: string;
  tracked: boolean;
  abs: string;
  size: number;
  mode: FileMode;
  ino: bigint;
  dev: bigint;
}

export interface ScopeScan {
  files: ScopeEntry[];
  deleted: string[];
  unsupported: { path: string; kind: string }[];
  blockers: Blocker[];
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function splitNul(buf: Buffer, blockers: Blocker[]): string[] {
  let text: string;
  try {
    text = strictUtf8.decode(buf);
  } catch {
    blockers.push({ code: 'UNSUPPORTED_ENTRY', reason: 'non-utf8-path' });
    text = buf.toString('latin1');
  }
  return text.split('\0').filter(Boolean);
}

// What `git add -A` would pick up, minus our defaults for *new* files:
//   tracked files (always)  +  untracked, not ignored, not default-excluded.
// `.gitignore` is honored because the repo is the design project: what Git
// ignores is not design content. The config file is always in scope.
export async function scanScope(git: RepoGit, cfg: Pick<ProjectConfig, 'excludeDirNames' | 'excludeFilePatterns'>): Promise<ScopeScan> {
  const blockers: Blocker[] = [];
  const unsupported: ScopeScan['unsupported'] = [];
  const tracked = new Set<string>();

  const staged = await git.run(['ls-files', '-s', '-z']);
  for (const rec of splitNul(staged.stdoutBuffer, blockers)) {
    const tab = rec.indexOf('\t');
    const [mode = '', , stage = ''] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (stage !== '0') blockers.push({ code: 'REPO_BUSY', reason: 'unmerged-entries', details: { path: p } });
    else if (mode === '160000') blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'submodule', details: { path: p } });
    else if (mode === '120000') unsupported.push({ path: p, kind: 'symlink' });
    else tracked.add(p);
  }

  const excludeArgs = [...cfg.excludeDirNames.map((d) => `--exclude=${d}/`), ...cfg.excludeFilePatterns.map((f) => `--exclude=${f}`)];
  const others = await git.run(['ls-files', '-z', '--others', '--exclude-standard', ...excludeArgs]);
  const untracked = new Set<string>();
  for (const p of splitNul(others.stdoutBuffer, blockers)) {
    if (p.endsWith('/')) blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'nested-repo', details: { path: p } });
    else untracked.add(p);
  }

  const all = new Set<string>([...tracked, ...untracked]);
  const unsupportedPaths = new Set(unsupported.map((u) => u.path));
  try {
    await lstat(join(git.root, CONFIG_FILE));
    if (!all.has(CONFIG_FILE) && !unsupportedPaths.has(CONFIG_FILE)) all.add(CONFIG_FILE);
  } catch {
    /* no config yet */
  }

  const okDirs = new Set<string>();
  const files: ScopeEntry[] = [];
  const deleted: string[] = [];
  const paths = [...all].sort();
  await mapLimit(paths, 16, async (p) => {
    if (!isSafeRelPath(p) || p.includes('\n')) {
      unsupported.push({ path: p, kind: 'invalid-name' });
      return;
    }
    const st = await lstatInside(git.root, p, okDirs);
    if (st === null) {
      deleted.push(p);
      return;
    }
    if (st === 'bad-parent') {
      unsupported.push({ path: p, kind: 'symlink-or-file-parent' });
      return;
    }
    if (st.isSymbolicLink()) unsupported.push({ path: p, kind: 'symlink' });
    else if (!st.isFile()) unsupported.push({ path: p, kind: 'special' });
    else
      files.push({
        path: p,
        tracked: tracked.has(p),
        abs: join(git.root, p),
        size: Number(st.size),
        mode: (st.mode & 0o100n) !== 0n ? '100755' : '100644',
        ino: st.ino,
        dev: st.dev,
      });
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  deleted.sort();
  return { files, deleted, unsupported, blockers };
}

// lstat that refuses to see through a symlinked or non-directory parent. Git
// hands us index paths; a tracked `a/secret` whose `a` was swapped for a link
// to /etc must never be read.
async function lstatInside(root: string, rel: string, okDirs: Set<string>) {
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i] as string);
    const key = parts.slice(0, i + 1).join('/');
    if (okDirs.has(key)) continue;
    let st;
    try {
      st = await lstat(cur, { bigint: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw e;
    }
    if (!st.isDirectory()) return 'bad-parent' as const;
    okDirs.add(key);
  }
  try {
    return await lstat(join(cur, parts[parts.length - 1] as string), { bigint: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

// Paths that would land on the same entry of a case- or normalization-
// insensitive filesystem (APFS/NTFS defaults).
export function findPathCollisions(paths: string[]): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      let set = byKey.get(key);
      if (!set) byKey.set(key, (set = new Set()));
      set.add(prefix);
    }
  }
  return [...byKey.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

export interface FileDigest {
  size: number;
  sha256: string;
  gitOid: string;
}

function digester(size: number): { t: Transform; done: () => FileDigest } {
  const h256 = createHash('sha256');
  const h1 = createHash('sha1');
  h1.update(`blob ${size}\0`);
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h256.update(chunk);
      h1.update(chunk);
      n += chunk.length;
      cb(null, chunk);
    },
  });
  return { t, done: () => ({ size: n, sha256: h256.digest('hex'), gitOid: h1.digest('hex') }) };
}

const discard = () => new Writable({ write: (_c, _e, cb) => cb() });

export async function hashFile(entry: { abs: string; ino: bigint; dev: bigint }): Promise<FileDigest & { mode: FileMode }> {
  const fh = await open(entry.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.ino !== entry.ino || st.dev !== entry.dev) throw new Error(`file replaced during read: ${entry.abs}`);
    const d = digester(Number(st.size));
    await pipeline(fh.createReadStream({ highWaterMark: 1 << 20, autoClose: false }), d.t, discard());
    return { ...d.done(), mode: (st.mode & 0o100n) !== 0n ? '100755' : '100644' };
  } finally {
    await fh.close();
  }
}

// Streams one live file into an immutable staging file; `stable` is false if
// the inode, size, mtime or ctime changed while reading.
export async function stageFile(entry: ScopeEntry, stagedPath: string): Promise<FileDigest & { stable: boolean; mode: FileMode }> {
  const fh = await open(entry.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fh.stat({ bigint: true });
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev) return { size: 0, sha256: '', gitOid: '', stable: false, mode: entry.mode };
    const d = digester(Number(before.size));
    await pipeline(fh.createReadStream({ highWaterMark: 1 << 20, autoClose: false }), d.t, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }));
    const after = await lstat(entry.abs, { bigint: true });
    const digest = d.done();
    const stable =
      digest.size === Number(before.size) && after.ino === before.ino && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
    await chmod(stagedPath, 0o400);
    return { ...digest, stable, mode: (before.mode & 0o100n) !== 0n ? '100755' : '100644' };
  } finally {
    await fh.close();
  }
}

export async function fileHasCR(path: string): Promise<boolean> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    if ((chunk as Buffer).includes(0x0d)) return true;
  }
  return false;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface AttrInfo {
  filter: string;
  text: string;
  eol: string;
  ident: string;
  encoding: string;
}

// `git check-attr` reads .gitattributes only; it never runs a filter.
export async function checkAttributes(git: RepoGit, paths: string[]): Promise<Map<string, AttrInfo>> {
  const out = new Map<string, AttrInfo>();
  if (!paths.length) return out;
  const r = await git.run(['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'ident', 'working-tree-encoding'], { input: paths.join('\0') + '\0' });
  const parts = r.stdout.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const path = parts[i] as string;
    const attr = parts[i + 1] as string;
    const value = parts[i + 2] as string;
    let info = out.get(path);
    if (!info) out.set(path, (info = { filter: 'unspecified', text: 'unspecified', eol: 'unspecified', ident: 'unspecified', encoding: 'unspecified' }));
    if (attr === 'filter') info.filter = value;
    else if (attr === 'text') info.text = value;
    else if (attr === 'eol') info.eol = value;
    else if (attr === 'ident') info.ident = value;
    else if (attr === 'working-tree-encoding') info.encoding = value;
  }
  return out;
}

// Raw-bytes snapshots disagree with `git status` when an attribute makes Git
// rewrite content on add. Returns hard blockers, plus the paths whose content
// must additionally be checked for CR bytes (explicit text / eol conversion).
export function attributeVerdict(attrs: Map<string, AttrInfo>): { blockers: Blocker[]; convertingPaths: string[] } {
  const blockers: Blocker[] = [];
  const convertingPaths: string[] = [];
  const lfs: string[] = [];
  const filters: string[] = [];
  for (const [path, a] of attrs) {
    if (a.filter !== 'unspecified' && a.filter !== 'unset') (a.filter.toLowerCase() === 'lfs' ? lfs : filters).push(path);
    if (a.ident !== 'unspecified' && a.ident !== 'unset') filters.push(path);
    if (a.encoding !== 'unspecified') filters.push(path);
    const explicitText = a.text === 'set' || ((a.eol === 'lf' || a.eol === 'crlf') && (a.text === 'unspecified' || a.text === 'set'));
    if (explicitText) convertingPaths.push(path);
  }
  if (lfs.length) blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'git-lfs', details: { count: lfs.length, sample: lfs.slice(0, 3) } });
  if (filters.length) blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'attribute-filter', details: { count: filters.length, sample: filters.slice(0, 3) } });
  return { blockers, convertingPaths };
}
