import { DtError, PROJECT_CONFIG_FILE, serializeProjectConfig } from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MAX_ATTEMPTS,
  attributeVerdict,
  blobMode,
  captureScope,
  excludeRules,
  scanScope,
  type IndexEntry,
  type PathAttributes,
  type Workspace,
} from '../src/index.ts';
import { NO_ATTRS, World, oidOf, type FakeFile } from './world.ts';

async function rejection(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

function fixture(): World {
  const w = new World();
  w.write('index.html', '<h1>hi</h1>');
  w.write('style.css', 'h1{color:red}');
  w.write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  w.track('index.html', 'style.css', 'img/logo.png', PROJECT_CONFIG_FILE);
  w.write('new.html', '<p>new</p>');
  w.write('copy.css', 'h1{color:red}');
  return w;
}

describe('captureScope', () => {
  it('captures tracked and new files, staging only content Git does not have', async () => {
    const w = fixture();
    const progress: string[] = [];
    const cap = await captureScope(w.options({ onProgress: (p) => progress.push(p.stage) }));
    expect(cap.attempts).toBe(1);
    expect(cap.files.map((f) => f.path)).toEqual([
      PROJECT_CONFIG_FILE,
      'copy.css',
      'img/logo.png',
      'index.html',
      'new.html',
      'style.css',
    ]);
    const byPath = new Map(cap.files.map((f) => [f.path, f]));
    // Same bytes as a tracked file: Git has the blob, nothing staged.
    expect(byPath.get('copy.css')?.staged).toBeNull();
    expect(byPath.get('index.html')?.staged).toBeNull();
    const staged = byPath.get('new.html')?.staged;
    expect(staged).toMatch(/^\/staging\/attempt-1\/[0-9a-f]{40}$/);
    expect(w.staged.get(staged as string)?.toString()).toBe('<p>new</p>');
    expect(cap.newBytes).toBe('<p>new</p>'.length);
    expect(w.calls.stage).toBe(1);
    expect(cap.config.projectId).toBe(w.config.projectId);
    expect(progress).toEqual(expect.arrayContaining(['scan', 'hash', 'stage', 'verify']));
  });

  it('reports tracked files that are gone as deleted', async () => {
    const w = fixture();
    w.files.delete('style.css');
    const cap = await captureScope(w.options());
    expect(cap.deleted).toEqual(['style.css']);
    expect(cap.files.map((f) => f.path)).not.toContain('style.css');
  });

  it('reuses the blob of a renamed file: the index still references it', async () => {
    const w = fixture();
    const f = w.files.get('style.css') as FakeFile;
    w.files.delete('style.css');
    w.write('css/renamed.css', f.bytes);
    const cap = await captureScope(w.options());
    expect(cap.deleted).toEqual(['style.css']);
    expect(cap.files.find((x) => x.path === 'css/renamed.css')?.staged).toBeNull();
    expect(w.calls.stage).toBe(1); // only new.html
  });

  it('keeps default excludes away from new files only', async () => {
    const w = fixture();
    w.write('.env', 'SECRET=1');
    w.write('.DS_Store', 'x');
    w.write('node_modules/x.js', 'x');
    w.write('tracked/.env', 'TRACKED=1');
    w.track('tracked/.env');
    const paths = (await captureScope(w.options())).files.map((f) => f.path);
    expect(paths).toContain('tracked/.env');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.DS_Store');
    expect(paths).not.toContain('node_modules/x.js');
  });

  it('includes .drafttide.json even when .gitignore lists it', async () => {
    const w = new World();
    w.write('index.html', 'x');
    w.ignored.add(PROJECT_CONFIG_FILE);
    const paths = (await captureScope(w.options())).files.map((f) => f.path);
    expect(paths).toEqual([PROJECT_CONFIG_FILE, 'index.html']);
  });

  it('retries while a writer is active and succeeds once it stops', async () => {
    const w = fixture();
    let writes = 0;
    // Writes once during each of the first two attempts.
    w.onRead = (path, pass) => {
      const attempt = w.calls.prepare.length;
      if (path === 'index.html' && pass === 'hash' && attempt <= 2 && writes < attempt) {
        w.write('index.html', `<h1>v${++writes}</h1>`);
      }
    };
    const cap = await captureScope(w.options());
    expect(cap.attempts).toBe(3);
    expect(w.calls.discard).toEqual([1, 2]);
    expect(cap.files.find((f) => f.path === 'index.html')?.oid).toBe(oidOf(Buffer.from('<h1>v2</h1>')));
  });

  it('gives up with SOURCE_BUSY after three retries', async () => {
    const w = fixture();
    let n = 0;
    w.onRead = (path) => {
      if (path === 'new.html') w.write('new.html', `<p>${n++}</p>`);
    };
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('SOURCE_BUSY');
    expect(err.retryable).toBe(true);
    expect(err.details['changed']).toEqual(['new.html']);
    expect(w.calls.prepare).toEqual([1, 2, 3, 4]);
    expect(w.calls.discard).toEqual([1, 2, 3, 4]);
    expect(CAPTURE_MAX_ATTEMPTS).toBe(4);
    expect(w.staged.size).toBe(0);
  });

  it('notices a file replaced between the scan and the read', async () => {
    const w = fixture();
    let replaced = false;
    w.onRead = (path) => {
      if (path === 'index.html' && !replaced) {
        replaced = true;
        // Same content, new inode: an editor's atomic save.
        const f = w.files.get('style.css') as FakeFile;
        w.files.set('style.css', { ...f, ino: 999n });
      }
    };
    expect((await captureScope(w.options())).attempts).toBe(2);
  });

  it('notices files added or removed during the capture', async () => {
    const w = fixture();
    let once = false;
    w.onRead = (_path, pass) => {
      if (pass === 'stage' && !once) {
        once = true;
        w.write('late.html', 'late');
      }
    };
    const cap = await captureScope(w.options());
    expect(cap.attempts).toBe(2);
    expect(cap.files.map((f) => f.path)).toContain('late.html');
  });

  it('retries when the project settings change during the capture', async () => {
    const w = fixture();
    let once = false;
    const original = w.workspace();
    const ws: Workspace = {
      ...original,
      readProjectConfig: async () => {
        const r = await original.readProjectConfig();
        if (!once) {
          once = true;
          w.write(PROJECT_CONFIG_FILE, serializeProjectConfig({ ...w.config, name: 'Renamed' }));
        }
        return r;
      },
    };
    const cap = await captureScope(w.options({ workspace: ws }));
    expect(cap.attempts).toBe(2);
    expect(cap.config.name).toBe('Renamed');
  });

  it('applies the project excludes from .drafttide.json', async () => {
    const w = fixture();
    w.write(PROJECT_CONFIG_FILE, serializeProjectConfig({ ...w.config, excludeDirNames: ['drafts'] }));
    w.write('drafts/a.html', 'x');
    const paths = (await captureScope(w.options())).files.map((f) => f.path);
    expect(paths).not.toContain('drafts/a.html');
  });

  it('needs the project settings file', async () => {
    const w = fixture();
    w.files.delete(PROJECT_CONFIG_FILE);
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.details['reason']).toBe('missing');
  });

  it('refuses unsupported entries without retrying or skipping them', async () => {
    const w = fixture();
    w.symlinks.add('link.html');
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(err.details['entries']).toEqual([{ path: 'link.html', kind: 'symlink' }]);
    expect(w.calls.prepare).toEqual([1]);
    expect(w.calls.discard).toEqual([1]);
  });

  it('refuses paths that collide by case or normalization', async () => {
    const w = fixture();
    w.write('Index.html', 'upper');
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(err.details['entries']).toEqual([
      { path: 'Index.html', kind: 'path-collision' },
      { path: 'index.html', kind: 'path-collision' },
    ]);
  });

  it('refuses the probe’s blockers before reading anything', async () => {
    const w = fixture();
    w.probe = { ...w.probe, blockers: [{ code: 'REPO_BUSY', reason: 'merge-in-progress', details: {} }] };
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('REPO_BUSY');
    expect(err.retryable).toBe(true);
    expect(err.details['reason']).toBe('merge-in-progress');
    expect(w.calls.prepare).toEqual([]);
  });

  it('refuses unmerged and flagged index entries', async () => {
    const w = fixture();
    const e = w.index.get('style.css') as IndexEntry;
    w.index.set('style.css', { ...e, flag: 'skip-worktree' });
    expect((await rejection(captureScope(w.options()))).details['reason']).toBe('index-flags');
    w.index.set('style.css', { ...e, stage: 2 });
    const busy = await rejection(captureScope(w.options()));
    expect(busy.code).toBe('REPO_BUSY');
    expect(busy.details['reason']).toBe('unmerged-entries');
  });

  it('refuses LFS and filter attributes', async () => {
    const w = fixture();
    w.attrs.set('img/logo.png', { filter: 'lfs' });
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('REPO_UNSUPPORTED');
    expect(err.details['reason']).toBe('git-lfs');
  });

  it('refuses explicit line-ending conversion only on files with CR', async () => {
    const w = fixture();
    w.attrs.set('index.html', { text: 'set' });
    await expect(captureScope(w.options())).resolves.toBeTruthy();
    w.write('index.html', '<h1>hi</h1>\r\n');
    const err = await rejection(captureScope(w.options()));
    expect(err.details['reason']).toBe('line-ending-normalization');
    // text=auto keeps CRLF already in the index: fine.
    w.attrs.set('index.html', { text: 'auto', eol: 'crlf' });
    await expect(captureScope(w.options())).resolves.toBeTruthy();
  });

  it('checks free space for the new content before staging any of it', async () => {
    const w = fixture();
    w.dataFree = 1024;
    const err = await rejection(captureScope(w.options()));
    expect(err.code).toBe('INSUFFICIENT_DISK_SPACE');
    expect(err.details['volume']).toBe('app-data');
    expect(w.calls.stage).toBe(0);
    expect(w.calls.discard).toEqual([1]);
  });

  it('adds both needs up when staging and the project share a volume', async () => {
    const w = fixture();
    w.sameVolume = true;
    w.write('big.bin', Buffer.alloc(1024 * 1024, 7));
    const need = 64 * 1024 * 1024 + 2 * 1024 * 1024;
    w.dataFree = w.projectFree = need - 1;
    const err = await rejection(captureScope(w.options()));
    expect(err.details['volume']).toBe('shared');
    w.dataFree = w.projectFree = need + 64 * 1024;
    await expect(captureScope(w.options())).resolves.toBeTruthy();
  });

  it('stops at once when cancelled and discards the attempt', async () => {
    const w = fixture();
    const ac = new AbortController();
    w.onRead = () => ac.abort(new Error('cancelled by the user'));
    await expect(captureScope(w.options({ signal: ac.signal }))).rejects.toThrow('cancelled by the user');
    expect(w.calls.discard).toEqual([1]);
    expect(w.calls.stage).toBe(0);
  });

  it('records an executable-bit change, or keeps the index mode where it is not trusted', async () => {
    const w = fixture();
    w.write('run.sh', 'echo', true);
    w.track('run.sh');
    w.write('run.sh', 'echo', false);
    const trusted = await captureScope(w.options());
    expect(trusted.files.find((f) => f.path === 'run.sh')?.mode).toBe('100644');
    w.probe = { ...w.probe, trustExecutableBit: false };
    const kept = await captureScope(w.options());
    expect(kept.files.find((f) => f.path === 'run.sh')?.mode).toBe('100755');
    expect(kept.files.find((f) => f.path === 'new.html')?.mode).toBe('100644');
  });
});

describe('scope rules', () => {
  it('turns index entries into blockers or unsupported entries', async () => {
    const w = fixture();
    w.index.set('sub', { path: 'sub', mode: '160000', oid: 'a'.repeat(40), stage: 0, flag: null });
    w.index.set('link', { path: 'link', mode: '120000', oid: 'b'.repeat(40), stage: 0, flag: null });
    w.write('bad\\name.txt', 'x');
    const scan = await scanScope(w.repo(), w.workspace(), excludeRules(null));
    expect(scan.blockers.map((b) => b.reason)).toEqual(['gitlink-in-index']);
    expect(scan.blockers[0]?.details).toEqual({ count: 1, sample: ['sub'] });
    expect(scan.unsupported).toEqual([
      { path: 'bad\\name.txt', kind: 'invalid-name' },
      { path: 'link', kind: 'symlink' },
    ]);
  });

  it('merges the project excludes with the defaults', () => {
    const rules = excludeRules({ excludeDirNames: ['drafts', 'node_modules'], excludeFilePatterns: ['*.psd'] });
    expect(rules.dirNames).toContain('node_modules');
    expect(rules.dirNames.filter((d) => d === 'node_modules')).toHaveLength(1);
    expect(rules.dirNames).toContain('drafts');
    expect(rules.filePatterns).toContain('*.psd');
    expect(rules.filePatterns).toContain('.env');
  });

  it('classifies attributes', () => {
    const v = attributeVerdict(
      new Map<string, PathAttributes>([
        ['a.psd', { ...NO_ATTRS, filter: 'lfs', text: 'unset' }],
        ['b.txt', { ...NO_ATTRS, filter: 'crypt' }],
        ['c.txt', { ...NO_ATTRS, ident: 'set' }],
        ['d.txt', { ...NO_ATTRS, workingTreeEncoding: 'UTF-16' }],
        ['e.txt', { ...NO_ATTRS, text: 'set' }],
        ['f.txt', { ...NO_ATTRS, eol: 'crlf' }],
        ['g.txt', { ...NO_ATTRS, text: 'auto', eol: 'lf' }],
        ['h.bin', { ...NO_ATTRS, text: 'unset', eol: 'lf' }],
        ['i.txt', { ...NO_ATTRS, filter: 'unset', ident: 'unset' }],
      ]),
    );
    expect(v.blockers.map((b) => [b.reason, b.details['count']])).toEqual([
      ['git-lfs', 1],
      ['attribute-filter', 3],
    ]);
    expect([...v.convertingPaths].sort()).toEqual(['e.txt', 'f.txt']);
  });

  it('decides blob modes like git add', () => {
    const tracked = (mode: string): IndexEntry => ({ path: 'x', mode, oid: 'a'.repeat(40), stage: 0, flag: null });
    expect(blobMode(true, null, true)).toBe('100755');
    expect(blobMode(false, tracked('100755'), true)).toBe('100644');
    expect(blobMode(false, tracked('100755'), false)).toBe('100755');
    expect(blobMode(true, null, false)).toBe('100644');
    expect(blobMode(true, tracked('100644'), false)).toBe('100644');
  });
});
