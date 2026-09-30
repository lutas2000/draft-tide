import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canonicalJson } from './metadata.ts';

export type FileMode = '100644' | '100755';

export interface ScopePolicy {
  schemaVersion: 1;
  excludeDirNames: string[];
  excludeFilePatterns: string[];
}

// M1 plan §6.2 default exclusions. `.gitignore` is not consulted: it is not a
// safety boundary.
export const DEFAULT_SCOPE_POLICY: ScopePolicy = {
  schemaVersion: 1,
  excludeDirNames: ['.git', 'node_modules', '.cache', '.parcel-cache', '.next', '.turbo', '.claude', '.cursor', '.idea', '.vscode'],
  excludeFilePatterns: ['.git', '.DS_Store', 'Thumbs.db', '.env', '.env.*', '*.log', '*.tmp', '*.swp', '~$*', '*.pem', '*.key', '*.p12', 'id_rsa*', '.npmrc', '.*.dt-tmp-*'],
};

export function scopeHash(policy: ScopePolicy, entryFiles: string[]): string {
  return createHash('sha256').update(canonicalJson({ policy, entryFiles })).digest('hex');
}

function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${src}$`);
}

export interface ScanEntry {
  path: string;
  abs: string;
  size: number;
  mode: FileMode;
  ino: bigint;
  dev: bigint;
}

export interface ScanResult {
  files: ScanEntry[];
  excluded: { path: string; reason: string }[];
  unsupported: { path: string; kind: 'symlink' | 'special' | 'invalid-name' }[];
}

export async function scan(root: string, policy: ScopePolicy): Promise<ScanResult> {
  const filePatterns = policy.excludeFilePatterns.map(globToRegExp);
  const dirNames = new Set(policy.excludeDirNames);
  const result: ScanResult = { files: [], excluded: [], unsupported: [] };
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop() as string;
    const dirAbs = rel ? join(root, rel) : root;
    const names = await readdir(dirAbs);
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = join(dirAbs, name);
      if (!name.isWellFormed() || name.includes('\n')) {
        result.unsupported.push({ path: childRel, kind: 'invalid-name' });
        continue;
      }
      const st = await lstat(abs, { bigint: true });
      if (st.isDirectory()) {
        if (dirNames.has(name)) result.excluded.push({ path: `${childRel}/`, reason: `default-exclude:${name}` });
        else stack.push(childRel);
      } else if (st.isFile()) {
        const hit = filePatterns.find((re) => re.test(name));
        if (hit) result.excluded.push({ path: childRel, reason: `default-exclude:${hit.source}` });
        else
          result.files.push({
            path: childRel,
            abs,
            size: Number(st.size),
            mode: (st.mode & 0o100n) !== 0n ? '100755' : '100644',
            ino: st.ino,
            dev: st.dev,
          });
      } else if (st.isSymbolicLink()) {
        result.unsupported.push({ path: childRel, kind: 'symlink' });
      } else {
        result.unsupported.push({ path: childRel, kind: 'special' });
      }
    }
  }
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

// Paths that would land on the same entry of a case-insensitive or
// normalization-insensitive filesystem (APFS/NTFS defaults).
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

// Opens without following symlinks and checks it is still the scanned inode.
export async function hashFile(entry: Pick<ScanEntry, 'abs' | 'ino' | 'dev'>): Promise<FileDigest & { mode: FileMode }> {
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

// Streams one live file into an immutable staging file and reports whether it
// stayed the same inode / size / mtime / ctime for the whole read.
// Staging is discarded on a crash (no ref is published before objects are
// durable), so fsync per staged file is optional: M0 measures both.
export async function stageFile(entry: ScanEntry, stagedPath: string, fsync: boolean): Promise<FileDigest & { stable: boolean; mode: FileMode }> {
  const fh = await open(entry.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fh.stat({ bigint: true });
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev) {
      return { size: 0, sha256: '', gitOid: '', stable: false, mode: entry.mode };
    }
    const d = digester(Number(before.size));
    await pipeline(
      fh.createReadStream({ highWaterMark: 1 << 20, autoClose: false }),
      d.t,
      createWriteStream(stagedPath, { flags: 'wx', mode: 0o600, flush: fsync }),
    );
    const after = await lstat(entry.abs, { bigint: true });
    const digest = d.done();
    const stable =
      digest.size === Number(before.size) &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeNs === before.mtimeNs &&
      after.ctimeNs === before.ctimeNs;
    await chmod(stagedPath, 0o400);
    return { ...digest, stable, mode: (before.mode & 0o100n) !== 0n ? '100755' : '100644' };
  } finally {
    await fh.close();
  }
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
