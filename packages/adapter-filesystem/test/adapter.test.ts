import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  PROJECT_CONFIG_FILE,
  ProjectId,
  serializeProjectConfig,
  type ProjectConfig,
} from '@draft-tide/contracts';
import type { FileIdentity, PathInspection } from '@draft-tide/core';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalRoot,
  createStagingArea,
  digestFile,
  gitBlobOid,
  inspectPaths,
  measureTree,
  openWorkspace,
  readProjectConfigFile,
  volumeSpace,
  writeProjectConfigFile,
} from '../src/index.ts';

const onWindows = process.platform === 'win32';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function tempDir(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'dt-fs-')));
  created.push(d);
  return d;
}

function put(root: string, rel: string, content: string | Buffer, mode?: number): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, mode === undefined ? {} : { mode });
}

async function dtError(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

function identity(r: PathInspection | undefined): FileIdentity {
  if (r?.kind !== 'file') throw new Error(`not a file: ${JSON.stringify(r?.kind)}`);
  return r.identity;
}

function gitHashObject(bytes: Buffer): string {
  return execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { input: bytes, encoding: 'utf8' }).trim();
}

describe('canonicalRoot', () => {
  it.skipIf(onWindows)('resolves symlinks to one canonical folder', async () => {
    const real = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(real, link);
    expect(await canonicalRoot(link)).toBe(real);
    expect(await canonicalRoot(real)).toBe(real);
  });

  it('refuses relative paths, missing folders and files', async () => {
    expect((await dtError(canonicalRoot('relative/dir'))).code).toBe('INVALID_ARGUMENT');
    expect((await dtError(canonicalRoot(join(tempDir(), 'missing')))).code).toBe('LOCAL_ROOT_UNAVAILABLE');
    const dir = tempDir();
    put(dir, 'file.txt', 'x');
    const err = await dtError(canonicalRoot(join(dir, 'file.txt')));
    expect(err.code).toBe('LOCAL_ROOT_UNAVAILABLE');
    expect(err.details['reason']).toBe('not-a-directory');
  });

  it("refuses folders that contain, or sit inside, Draft Tide's data", async () => {
    const home = tempDir();
    const data = join(home, 'Library', 'Draft Tide');
    mkdirSync(join(data, 'projects'), { recursive: true });
    for (const root of [home, join(data, 'projects')]) {
      const err = await dtError(canonicalRoot(root, { appDataDir: data }));
      expect(err.code).toBe('REPO_UNSUPPORTED');
      expect(err.details['reason']).toBe('overlaps-app-data');
    }
    mkdirSync(join(home, 'Design'));
    expect(await canonicalRoot(join(home, 'Design'), { appDataDir: data })).toBe(join(home, 'Design'));
    // A data dir that does not exist yet still counts.
    const err = await dtError(canonicalRoot(home, { appDataDir: join(home, 'later', 'Draft Tide') }));
    expect(err.details['reason']).toBe('overlaps-app-data');
  });
});

describe('inspectPaths', () => {
  it('reports files, gone paths and folders that replaced files', async () => {
    const root = tempDir();
    put(root, 'a.html', 'hello');
    put(root, 'dir/b.css', 'x');
    put(root, 'was-file/inner.txt', 'now a folder');
    put(root, 'file-now', 'a file where a folder was');
    const [a, b, gone, folder, underFile] = await inspectPaths(root, [
      'a.html',
      'dir/b.css',
      'nope.txt',
      'was-file',
      'file-now/old.txt',
    ]);
    expect(a).toMatchObject({ kind: 'file', size: 5 });
    expect(b?.kind).toBe('file');
    expect(gone).toEqual({ kind: 'missing' });
    expect(folder).toEqual({ kind: 'missing' });
    expect(underFile).toEqual({ kind: 'missing' });
  });

  it.skipIf(onWindows)('reports the executable bit', async () => {
    const root = tempDir();
    put(root, 'run.sh', '#!/bin/sh\n', 0o755);
    put(root, 'plain.txt', 'x', 0o644);
    const [run, plain] = await inspectPaths(root, ['run.sh', 'plain.txt']);
    expect(run).toMatchObject({ kind: 'file', executable: true });
    expect(plain).toMatchObject({ kind: 'file', executable: false });
  });

  it.skipIf(onWindows)('never looks through a symlink, at the end or in a parent', async () => {
    const outside = tempDir();
    put(outside, 'secret.txt', 'OUTSIDE');
    const root = tempDir();
    put(root, 'ok.txt', 'x');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'a'));
    const [link, through, ok] = await inspectPaths(root, ['link.txt', 'a/secret.txt', 'ok.txt']);
    expect(link).toEqual({ kind: 'unsupported', reason: 'symlink' });
    expect(through).toEqual({ kind: 'unsupported', reason: 'parent-not-directory' });
    expect(ok?.kind).toBe('file');
  });

  it.skipIf(onWindows)('reports special files', async () => {
    const root = tempDir();
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(await inspectPaths(root, ['pipe'])).toEqual([{ kind: 'unsupported', reason: 'special' }]);
  });

  it.skipIf(onWindows || asRoot)('reports what it may not read instead of skipping it', async () => {
    const root = tempDir();
    put(root, 'locked/a.txt', 'x');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      expect(await inspectPaths(root, ['locked/a.txt'])).toEqual([{ kind: 'unsupported', reason: 'unreadable' }]);
    } finally {
      chmodSync(join(root, 'locked'), 0o700);
    }
  });
});

describe('digestFile', () => {
  it('computes the blob id Git computes, for any bytes', async () => {
    const root = tempDir();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
        put(root, 'f.bin', Buffer.from(bytes));
        const [r] = await inspectPaths(root, ['f.bin']);
        const d = await digestFile(root, 'f.bin', identity(r), null);
        expect(d.changed).toBe(false);
        if (d.changed) return;
        expect(d.digest.oid).toBe(gitBlobOid(bytes));
        expect(d.digest.size).toBe(bytes.length);
        expect(d.digest.hasCR).toBe(bytes.includes(13));
      }),
      { numRuns: 60 },
    );
    for (const sample of [Buffer.alloc(0), Buffer.from('a\r\nb\r\n'), Buffer.alloc(3 * 1024 * 1024 + 7, 0xab)]) {
      put(root, 'g.bin', sample);
      const [r] = await inspectPaths(root, ['g.bin']);
      const d = await digestFile(root, 'g.bin', identity(r), null);
      expect(!d.changed && d.digest.oid).toBe(gitHashObject(sample));
    }
  });

  it('stages an exact, read-only, exclusive copy', async () => {
    const root = tempDir();
    const stage = tempDir();
    const bytes = Buffer.from('<h1>定價</h1>\r\n');
    put(root, 'p/index.html', bytes);
    const [r] = await inspectPaths(root, ['p/index.html']);
    const dest = join(stage, 'copy');
    const d = await digestFile(root, 'p/index.html', identity(r), dest);
    expect(!d.changed && d.digest.oid).toBe(gitBlobOid(bytes));
    expect(readFileSync(dest)).toEqual(bytes);
    if (!onWindows) expect(statSync(dest).mode & 0o777).toBe(0o400);
    // Never over an existing file.
    const again = await dtError(digestFile(root, 'p/index.html', identity(r), dest));
    expect(again.code).toBe('STORAGE_IO_FAILED');
    expect(readFileSync(dest)).toEqual(bytes);
  });

  it('reports a file that is no longer the one scanned, and keeps no copy of it', async () => {
    const root = tempDir();
    const stage = tempDir();
    put(root, 'a.txt', 'one');
    const [r] = await inspectPaths(root, ['a.txt']);
    // An editor's atomic save: new inode under the same name.
    put(root, 'a.tmp', 'two');
    renameSync(join(root, 'a.tmp'), join(root, 'a.txt'));
    expect(await digestFile(root, 'a.txt', identity(r), join(stage, 'x'))).toEqual({ changed: true });
    expect(existsSync(join(stage, 'x'))).toBe(false);
    rmSync(join(root, 'a.txt'));
    expect(await digestFile(root, 'a.txt', identity(r), null)).toEqual({ changed: true });
  });

  it.skipIf(onWindows)('cannot be made to read outside the folder by swapping a parent after the scan', async () => {
    const outside = tempDir();
    put(outside, 'secret.txt', 'OUTSIDE');
    const root = tempDir();
    put(root, 'a/secret.txt', 'inside');
    const [r] = await inspectPaths(root, ['a/secret.txt']);
    rmSync(join(root, 'a'), { recursive: true });
    symlinkSync(outside, join(root, 'a'));
    const stage = tempDir();
    expect(await digestFile(root, 'a/secret.txt', identity(r), join(stage, 'x'))).toEqual({ changed: true });
    expect(existsSync(join(stage, 'x'))).toBe(false);
  });

  it.skipIf(onWindows)('reports a file swapped for a symlink as changed', async () => {
    const root = tempDir();
    put(root, 'a.txt', 'x');
    const [r] = await inspectPaths(root, ['a.txt']);
    rmSync(join(root, 'a.txt'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'a.txt'));
    expect(await digestFile(root, 'a.txt', identity(r), null)).toEqual({ changed: true });
  });

  it('reports a file that changed size behind the scan', async () => {
    const root = tempDir();
    put(root, 'a.txt', 'short');
    const [r] = await inspectPaths(root, ['a.txt']);
    writeFileSync(join(root, 'a.txt'), 'much longer now');
    // Same inode, new content: the digest is of what is there now; the
    // capture's verify pass compares it.
    const d = await digestFile(root, 'a.txt', identity(r), null);
    expect(!d.changed && d.digest.oid).toBe(gitBlobOid(Buffer.from('much longer now')));
  });

  it('can be cancelled', async () => {
    const root = tempDir();
    put(root, 'big.bin', Buffer.alloc(8 * 1024 * 1024));
    const [r] = await inspectPaths(root, ['big.bin']);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const stage = tempDir();
    await expect(digestFile(root, 'big.bin', identity(r), join(stage, 'x'), ac.signal)).rejects.toThrow('stop');
    expect(existsSync(join(stage, 'x'))).toBe(false);
  });
});

describe('readProjectConfigFile', () => {
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId: ProjectId.parse(randomUUID()),
    name: '定價頁',
    entryFiles: ['index.html'],
    excludeDirNames: [],
    excludeFilePatterns: [],
  };

  it('reads a valid file with the blob id of its exact bytes', async () => {
    const root = tempDir();
    expect(await readProjectConfigFile(root)).toBeNull();
    const text = serializeProjectConfig(config);
    put(root, PROJECT_CONFIG_FILE, text);
    const r = await readProjectConfigFile(root);
    expect(r?.config).toEqual(config);
    expect(r?.oid).toBe(gitHashObject(Buffer.from(text)));
  });

  it.each([
    ['a folder', (root: string) => mkdirSync(join(root, PROJECT_CONFIG_FILE)), 'not-regular-file'],
    [
      'too large',
      (root: string) => put(root, PROJECT_CONFIG_FILE, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1)),
      'too-large',
    ],
    ['not JSON', (root: string) => put(root, PROJECT_CONFIG_FILE, '{nope'), 'not-json'],
    ['not UTF-8', (root: string) => put(root, PROJECT_CONFIG_FILE, Buffer.from([0x7b, 0xff, 0x7d])), 'not-json'],
    [
      'an unknown field',
      (root: string) => put(root, PROJECT_CONFIG_FILE, JSON.stringify({ ...config, run: 'x' })),
      'schema',
    ],
  ])('refuses %s as CONFIG_INVALID', async (_name, make, reason) => {
    const root = tempDir();
    make(root);
    const err = await dtError(readProjectConfigFile(root));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.details['reason']).toBe(reason);
  });

  it.skipIf(onWindows)('refuses a symlink, even to a valid file', async () => {
    const outside = tempDir();
    put(outside, 'real.json', JSON.stringify(config));
    const root = tempDir();
    symlinkSync(join(outside, 'real.json'), join(root, PROJECT_CONFIG_FILE));
    const err = await dtError(readProjectConfigFile(root));
    expect(err.details['reason']).toBe('not-regular-file');
  });
});

describe('writeProjectConfigFile', () => {
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId: ProjectId.parse(randomUUID()),
    name: 'Landing',
    entryFiles: ['index.html'],
    excludeDirNames: [],
    excludeFilePatterns: [],
  };
  const bytes = (c: ProjectConfig) => Buffer.from(serializeProjectConfig(c));
  const leftovers = (root: string) => readdirSync(root).filter((n) => n.includes('dt-tmp'));

  it('creates the file where there was none, readable like any design file', async () => {
    const root = tempDir();
    await writeProjectConfigFile(root, bytes(config), null);
    expect((await readProjectConfigFile(root))?.config).toEqual(config);
    if (!onWindows) expect(statSync(join(root, PROJECT_CONFIG_FILE)).mode & 0o777).toBe(0o644);
    expect(leftovers(root)).toEqual([]);
  });

  it('replaces the reviewed bytes, keeping the file mode', async () => {
    const root = tempDir();
    put(root, PROJECT_CONFIG_FILE, bytes(config));
    chmodSync(join(root, PROJECT_CONFIG_FILE), 0o664);
    const next = { ...config, name: 'Renamed' };
    await writeProjectConfigFile(root, bytes(next), gitBlobOid(bytes(config)));
    expect((await readProjectConfigFile(root))?.config.name).toBe('Renamed');
    if (!onWindows) expect(statSync(join(root, PROJECT_CONFIG_FILE)).mode & 0o777).toBe(0o664);
  });

  it.each([
    ['appeared since the review', (root: string) => put(root, PROJECT_CONFIG_FILE, bytes(config)), null],
    ['was edited since the review', (root: string) => put(root, PROJECT_CONFIG_FILE, '{"edited":1}'), 'reviewed'],
    ['was removed since the review', () => undefined, 'reviewed'],
    ['is a folder now', (root: string) => mkdirSync(join(root, PROJECT_CONFIG_FILE)), 'reviewed'],
  ])('refuses with SCOPE_CHANGED when the file %s, writing nothing', async (_name, make, expected) => {
    const root = tempDir();
    make(root);
    const before = existsSync(join(root, PROJECT_CONFIG_FILE))
      ? lstatSync(join(root, PROJECT_CONFIG_FILE)).mtimeMs
      : null;
    const err = await dtError(
      writeProjectConfigFile(root, bytes(config), expected === null ? null : gitBlobOid(bytes(config))),
    );
    expect(err.code).toBe('SCOPE_CHANGED');
    const after = existsSync(join(root, PROJECT_CONFIG_FILE))
      ? lstatSync(join(root, PROJECT_CONFIG_FILE)).mtimeMs
      : null;
    expect(after).toBe(before);
    expect(leftovers(root)).toEqual([]);
  });

  it.skipIf(onWindows)('never writes through a symlink in its place', async () => {
    const outside = tempDir();
    put(outside, 'target.json', 'outside');
    const root = tempDir();
    symlinkSync(join(outside, 'target.json'), join(root, PROJECT_CONFIG_FILE));
    const err = await dtError(writeProjectConfigFile(root, bytes(config), gitBlobOid(Buffer.from('outside'))));
    expect(err.code).toBe('SCOPE_CHANGED');
    expect(readFileSync(join(outside, 'target.json'), 'utf8')).toBe('outside');
  });
});

describe('staging and space', () => {
  it('stages under the data directory with private permissions, and cleans up', async () => {
    const data = tempDir();
    const projectId = randomUUID();
    const operationId = randomUUID();
    const staging = await createStagingArea(data, projectId, operationId);
    expect(staging.dir).toBe(join(data, 'projects', projectId, 'operations', operationId, 'staging'));
    await staging.prepareAttempt(1);
    const oid = 'a'.repeat(40);
    expect(staging.pathFor(1, oid)).toBe(join(staging.dir, 'attempt-1', oid));
    writeFileSync(staging.pathFor(1, oid), 'x', { mode: 0o400 });
    if (!onWindows) {
      expect(lstatSync(staging.dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(staging.dir, 'attempt-1')).mode & 0o777).toBe(0o700);
    }
    await staging.discardAttempt(1);
    expect(existsSync(join(staging.dir, 'attempt-1'))).toBe(false);
    expect(() => staging.pathFor(1, '../../x')).toThrow();
    expect((await staging.space()).availableBytes).toBeGreaterThan(0);
    await staging.remove();
    expect(existsSync(join(data, 'projects', projectId, 'operations', operationId))).toBe(false);
  });

  it('refuses ids that are not UUIDs as path components', async () => {
    const data = tempDir();
    await expect(createStagingArea(data, '../escape', randomUUID())).rejects.toThrow(DtError);
    await expect(createStagingArea(data, randomUUID(), 'x/../../y')).rejects.toThrow(DtError);
  });

  it('reports free space per volume', async () => {
    const a = tempDir();
    const b = tempDir();
    const [sa, sb] = await Promise.all([volumeSpace(a), volumeSpace(b)]);
    expect(sa.availableBytes).toBeGreaterThan(0);
    expect(sa.volume).toBe(sb.volume);
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    expect((await openWorkspace(root).projectSpace()).volume).toBe(sa.volume);
  });

  it('measures a tree by part, never through a link, within its budget', async () => {
    const data = tempDir();
    const outside = tempDir();
    put(outside, 'huge.bin', Buffer.alloc(50_000));
    put(data, 'state.sqlite', Buffer.alloc(4096));
    put(data, 'state.sqlite-wal', Buffer.alloc(100));
    put(data, 'projects/p/cache/previews/a.png', Buffer.alloc(300));
    put(data, 'projects/p/operations/o/staging/x', Buffer.alloc(70));
    put(data, 'diagnostics/engine.log', 'log line\n');
    if (!onWindows) {
      symlinkSync(outside, join(data, 'link'));
      symlinkSync(join(outside, 'huge.bin'), join(data, 'projects', 'p', 'cache', 'big.png'));
    }
    const classify = (s: readonly string[]) =>
      s[0]?.startsWith('state.sqlite')
        ? 'database'
        : s[0] === 'projects' && s[2] === 'cache'
          ? 'previews'
          : s[0] === 'projects' && s[2] === 'operations'
            ? 'staging'
            : s[0] === 'diagnostics'
              ? 'logs'
              : 'other';
    const m = await measureTree(data, classify);
    expect(m.complete).toBe(true);
    expect(Object.fromEntries(m.bytes)).toEqual({ database: 4196, previews: 300, staging: 70, logs: 9 });
    const cut = await measureTree(data, classify, 3);
    expect(cut.complete).toBe(false);
    expect((await measureTree(join(data, 'nothing-here'), classify)).bytes.size).toBe(0);
  });
});

describe('openWorkspace', () => {
  it('refuses paths that leave the folder', async () => {
    const root = tempDir();
    const ws = openWorkspace(root);
    const id: FileIdentity = { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n };
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', '.git/config', 'a\\b']) {
      await expect(ws.hash(bad, id)).rejects.toSatisfy((e) => e instanceof DtError && e.code === 'PATH_OUTSIDE_ROOT');
      await expect(ws.inspect([bad])).rejects.toSatisfy((e) => e instanceof DtError && e.code === 'PATH_OUTSIDE_ROOT');
    }
  });
});
