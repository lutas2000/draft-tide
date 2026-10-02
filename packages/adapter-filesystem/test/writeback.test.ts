import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitBlobOid, openWorkspace } from '../src/index.ts';

// Write-back (M1 plan §9.3 step 6): one file at a time, only while the path
// still holds what the operation expects, through a temporary file and a
// rename; parents are real folders.

const onWindows = process.platform === 'win32';
const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'dt-wb-')));
  created.push(d);
  return d;
}

const bytes = (s: string) => new TextEncoder().encode(s);
// As Git delivers a blob: chunks that arrive asynchronously.
async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) {
    await Promise.resolve();
    yield bytes(p);
  }
}
const oidOf = (s: string) => gitBlobOid(bytes(s));
const leftovers = (dir: string) => readdirSync(dir, { recursive: true }).filter((p) => String(p).includes('.dt-tmp-'));

describe('writing a file back', () => {
  it('creates a file where nothing is, with its parents as real folders', async () => {
    const root = folder();
    const ws = openWorkspace(root);
    const r = await ws.writeFile('pages/深/a.html', chunks('<h1>', 'a</h1>\n'), {
      mode: '100644',
      expected: null,
      oid: oidOf('<h1>' + 'a</h1>\n'),
    });
    expect(r).toEqual({ changed: false });
    expect(readFileSync(join(root, 'pages/深/a.html'), 'utf8')).toBe('<h1>a</h1>\n');
    if (!onWindows) {
      expect(statSync(join(root, 'pages/深/a.html')).mode & 0o777).toBe(0o644);
      expect(statSync(join(root, 'pages')).mode & 0o777).toBe(0o755);
    }
    expect(leftovers(root)).toEqual([]);
  });

  it('replaces a file only while it still has the expected content', async () => {
    const root = folder();
    writeFileSync(join(root, 'a.html'), 'old\n');
    const ws = openWorkspace(root);
    expect(
      await ws.writeFile('a.html', chunks('new\n'), {
        mode: '100755',
        expected: oidOf('other\n'),
        oid: oidOf('new\n'),
      }),
    ).toEqual({
      changed: true,
    });
    expect(readFileSync(join(root, 'a.html'), 'utf8')).toBe('old\n');
    expect(
      await ws.writeFile('a.html', chunks('new\n'), { mode: '100755', expected: null, oid: oidOf('new\n') }),
    ).toEqual({
      changed: true,
    });
    expect(
      await ws.writeFile('a.html', chunks('new\n'), { mode: '100755', expected: oidOf('old\n'), oid: oidOf('new\n') }),
    ).toEqual({
      changed: false,
    });
    expect(readFileSync(join(root, 'a.html'), 'utf8')).toBe('new\n');
    if (!onWindows) expect(statSync(join(root, 'a.html')).mode & 0o777).toBe(0o755);
    expect(leftovers(root)).toEqual([]);
  });

  it('takes the place of an empty folder, but never of one with files in it', async () => {
    const root = folder();
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, 'full'));
    writeFileSync(join(root, 'full', 'keep.txt'), 'keep\n');
    const ws = openWorkspace(root);
    expect(await ws.writeFile('empty', chunks('x\n'), { mode: '100644', expected: null, oid: oidOf('x\n') })).toEqual({
      changed: false,
    });
    expect(readFileSync(join(root, 'empty'), 'utf8')).toBe('x\n');
    expect(await ws.writeFile('full', chunks('x\n'), { mode: '100644', expected: null, oid: oidOf('x\n') })).toEqual({
      changed: true,
    });
    expect(readFileSync(join(root, 'full', 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it.skipIf(onWindows)('never writes through a parent that is a link or a file', async () => {
    const root = folder();
    const outside = folder();
    symlinkSync(outside, join(root, 'linked'));
    writeFileSync(join(root, 'plain'), 'a file\n');
    const ws = openWorkspace(root);
    expect(
      await ws.writeFile('linked/a.html', chunks('x'), { mode: '100644', expected: null, oid: oidOf('x') }),
    ).toEqual({
      changed: true,
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(
      await ws.writeFile('plain/a.html', chunks('x'), { mode: '100644', expected: null, oid: oidOf('x') }),
    ).toEqual({
      changed: true,
    });
    expect(readFileSync(join(root, 'plain'), 'utf8')).toBe('a file\n');
  });

  it('refuses paths outside the folder', async () => {
    const ws = openWorkspace(folder());
    await expect(
      ws.writeFile('../x', chunks('x'), { mode: '100644', expected: null, oid: oidOf('x') }),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    });
    await expect(ws.removeFile('.git/config', oidOf('x'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  it('leaves nothing behind when the content stream fails', async () => {
    const root = folder();
    const ws = openWorkspace(root);
    async function* broken(): AsyncIterable<Uint8Array> {
      yield* chunks('part');
      throw new Error('git stopped');
    }
    await expect(
      ws.writeFile('a.html', broken(), { mode: '100644', expected: null, oid: oidOf('part') }),
    ).rejects.toMatchObject({
      code: 'STORAGE_IO_FAILED',
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('never lets bytes other than the version’s replace a file', async () => {
    const root = folder();
    writeFileSync(join(root, 'a.html'), 'old\n');
    const ws = openWorkspace(root);
    // A stream cut short: what arrived isn't the blob the version holds.
    await expect(
      ws.writeFile('a.html', chunks('ne'), { mode: '100644', expected: oidOf('old\n'), oid: oidOf('new\n') }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect(readFileSync(join(root, 'a.html'), 'utf8')).toBe('old\n');
    expect(leftovers(root)).toEqual([]);
  });

  it('tells another spelling of a name apart from the name itself', async () => {
    const root = folder();
    mkdirSync(join(root, 'Pages'));
    writeFileSync(join(root, 'Pages', 'Logo.png'), 'logo');
    const ws = openWorkspace(root);
    expect(await ws.exactNames(['Pages/Logo.png', 'pages/Logo.png', 'Pages/logo.png', 'Pages', 'nope'])).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    // On a case-insensitive filesystem, `pages/logo.png` resolves to the
    // file; it is still not that name, so it is neither replaced nor removed.
    expect(await ws.removeFile('Pages/logo.png', oidOf('logo'))).toEqual({ changed: true });
    expect(
      await ws.writeFile('Pages/logo.png', chunks('x'), { mode: '100644', expected: oidOf('logo'), oid: oidOf('x') }),
    ).toEqual({ changed: true });
    expect(readFileSync(join(root, 'Pages', 'Logo.png'), 'utf8')).toBe('logo');
  });
});

describe('removing a file', () => {
  it('removes it only with the expected content, then folders it left empty', async () => {
    const root = folder();
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'a/b/c.txt'), 'c\n');
    writeFileSync(join(root, 'a/keep.txt'), 'keep\n');
    const ws = openWorkspace(root);
    expect(await ws.removeFile('a/b/c.txt', oidOf('other\n'))).toEqual({ changed: true });
    expect(readFileSync(join(root, 'a/b/c.txt'), 'utf8')).toBe('c\n');
    expect(await ws.removeFile('a/b/c.txt', oidOf('c\n'))).toEqual({ changed: false });
    expect(readdirSync(join(root, 'a'))).toEqual(['keep.txt']);
    expect(await ws.removeFile('a/b/c.txt', oidOf('c\n'))).toEqual({ changed: true });
  });
});

describe('looking at what is in the way', () => {
  it('tells files, folders, links and nothing apart, and lists a folder', async () => {
    const root = folder();
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    writeFileSync(join(root, 'dir/sub/x.txt'), 'x');
    writeFileSync(join(root, 'file'), 'f');
    if (!onWindows) symlinkSync('file', join(root, 'link'));
    const ws = openWorkspace(root);
    expect(await ws.occupants(['dir', 'file', 'missing', ...(onWindows ? [] : ['link'])])).toEqual([
      'folder',
      'file',
      'missing',
      ...(onWindows ? [] : ['link']),
    ]);
    expect(await ws.listFolder('dir', 10)).toEqual({ entries: ['dir/sub/x.txt'], complete: true });
    writeFileSync(join(root, 'dir/y.txt'), 'y');
    expect((await ws.listFolder('dir', 1)).complete).toBe(false);
  });
});
