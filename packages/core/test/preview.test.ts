import { createHash, randomUUID } from 'node:crypto';
import {
  DtError,
  EngineInstanceId,
  IsoTimestamp,
  OperationId,
  PROJECT_CONFIG_FILE,
  PreviewArtifact,
  ProjectId,
  SnapshotId,
  formatCommitMessage,
  serializeProjectConfig,
  type PreviewChunk,
  type ProjectSummary,
} from '@draft-tide/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createEngineCore,
  createFileSource,
  createPreviewService,
  createProjectContext,
  decodePreviewPath,
  fitWithin,
  imageInfo,
  type GitCommit,
  type GitTreeEntry,
  type PreviewImageStore,
  type PreviewRenderer,
  type ProjectGit,
  type ProjectHost,
  type RenderJob,
  type RenderOutput,
  type Workspace,
} from '../src/index.ts';
import { memoryStore } from './memory-store.ts';

// Previews through the Engine core with an in-memory repo of versions and a
// fake renderer. The real Preview Host (Electron) runs in the desktop E2E;
// the Engine's supervisor against a scripted host in the companion's tests.

const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
const blobId = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

// A PNG header (signature and IHDR) of the given size: all core reads.
function pngOf(width: number, height: number, tag = 0): Buffer {
  const b = Buffer.alloc(33 + 12 + 4);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  b.writeUInt32BE(tag, 45);
  return b;
}

function jpegOf(width: number, height: number, appBytes = 20): Buffer {
  const app1 = Buffer.alloc(2 + 2 + appBytes);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(appBytes + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    Buffer.from([0xff, 0xff]),
    sof,
    Buffer.alloc(14),
    Buffer.from([0xff, 0xd9]),
  ]);
}

type Files = Record<string, string | Buffer | { link: string }>;

function chunksOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: () =>
          Promise.resolve(
            i < chunks.length
              ? { value: chunks[i++] as Uint8Array, done: false as const }
              : { value: undefined, done: true as const },
          ),
      };
    },
  };
}

class Versions {
  commits: GitCommit[] = [];
  trees = new Map<string, GitTreeEntry[]>();
  blobs = new Map<string, Buffer>();
  streamed: string[] = [];

  add(files: Files, snapshotId = SnapshotId.parse(randomUUID())): { commit: string; snapshotId: string } {
    const entries: GitTreeEntry[] = Object.entries(files).map(([path, content]) => {
      if (typeof content === 'object' && !Buffer.isBuffer(content)) {
        const b = Buffer.from(content.link);
        this.blobs.set(blobId(b), b);
        return { path, mode: '120000', type: 'blob', oid: blobId(b), size: b.length };
      }
      const b = Buffer.from(content);
      this.blobs.set(blobId(b), b);
      return { path, mode: '100644', type: 'blob', oid: blobId(b), size: b.length };
    });
    const tree = sha1(JSON.stringify(entries.map((e) => [e.path, e.oid])));
    this.trees.set(tree, entries);
    const parent = this.commits.at(-1)?.oid;
    const message = formatCommitMessage({
      schemaVersion: 1,
      snapshotId: SnapshotId.parse(snapshotId),
      kind: 'manual',
      createdAt: IsoTimestamp.parse('2026-10-02T08:30:00.123Z'),
      origin: 'gui',
      operationId: OperationId.parse(randomUUID()),
    });
    const person = { name: 'Draft Tide', email: 'x@localhost', time: 1_790_000_000, offset: '+0000' };
    const oid = sha1(`${tree}${this.commits.length}`);
    this.commits.push({
      oid,
      tree,
      parents: parent ? [parent] : [],
      author: person,
      committer: person,
      message,
      truncated: false,
    });
    return { commit: oid, snapshotId };
  }

  repo(): ProjectGit {
    const tip = () => this.commits.at(-1)?.oid ?? null;
    const unused = () => {
      throw new Error('not used by previews');
    };
    const repo: Partial<ProjectGit> = {
      root: '/design',
      probe: () =>
        Promise.resolve({
          hasRepo: true,
          headRef: 'refs/heads/main',
          branch: 'main',
          tip: tip(),
          trustExecutableBit: true,
          blockers: [],
          warnings: [],
        }),
      firstParentLine: (from, { skip, limit }) => {
        const newest = [...this.commits].reverse();
        const at = newest.findIndex((c) => c.oid === from);
        return Promise.resolve(newest.slice(at + skip, at + skip + limit).map((c) => c.oid));
      },
      readCommits: (oids) => Promise.resolve(oids.map((o) => this.commits.find((c) => c.oid === o) as GitCommit)),
      listTree: (tree) => Promise.resolve({ entries: this.trees.get(tree) ?? [], nonUtf8: [] }),
      lookupPath: (tree, path) => Promise.resolve(this.trees.get(tree)?.find((e) => e.path === path) ?? null),
      streamBlob: (oid) => {
        this.streamed.push(oid);
        const b = this.blobs.get(oid);
        return chunksOf(b ? [new Uint8Array(b)] : []);
      },
      // Recovery at start looks for Draft Tide's leftovers: there are none.
      indexLock: () => Promise.resolve({ held: false }),
      preparedIndexes: () => Promise.resolve([]),
      writeBlobs: unused,
    };
    return repo as ProjectGit;
  }
}

const config = (projectId: string, entryFiles: string[]) =>
  serializeProjectConfig({
    schemaVersion: 1,
    projectId: ProjectId.parse(projectId),
    name: 'Fixture',
    entryFiles,
    excludeDirNames: [],
    excludeFilePatterns: [],
  });

// Renders by reading what the job's page would ask for (`reads`), then
// answers with PNGs of the requested sizes.
class FakeRenderer implements PreviewRenderer {
  rendererId: string | null = 'electron/1 chromium/2';
  jobs: RenderJob[] = [];
  reads: string[] = ['/index.html', '/style.css', '/logo.png', '/missing.png', '/%2e%2e/secret'];
  served: Record<string, string> = {};
  gate: Promise<void> | null = null;
  output: (job: RenderJob) => Partial<RenderOutput> = () => ({});
  fail: DtError | null = null;

  // The style.css each render was served, in the order they ran.
  order: string[] = [];

  async render(
    job: RenderJob,
    files: { read(p: string): Promise<{ status: string; bytes?: Uint8Array }> },
  ): Promise<RenderOutput> {
    this.jobs.push(job);
    if (this.gate) await this.gate;
    if (job.subject.kind === 'page') {
      const css = await files.read('/style.css');
      if (css.bytes) this.order.push(Buffer.from(css.bytes).toString());
    }
    if (this.fail) throw this.fail;
    for (const r of job.subject.kind === 'image' ? [`/${job.subject.path}`, '/index.html'] : this.reads) {
      this.served[r] = (await files.read(r)).status;
    }
    return {
      full: { png: pngOf(job.output.width, job.output.height, this.jobs.length), ...job.output },
      thumbnail: { png: pngOf(job.thumbnail.width, job.thumbnail.height), ...job.thumbnail },
      blocked: { count: 1, entries: [{ kind: 'network', target: 'https://fonts.example/\u001b[31mx' }] },
      environment: {
        renderer: 'electron/1 chromium/2',
        electron: '1',
        chromium: '2',
        platform: 'test',
        osRelease: '1',
      },
      ...this.output(job),
    };
  }
}

function memoryImages(): PreviewImageStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const name = (p: string, k: string, i: string) => `${p}/${k}/${i}`;
  return {
    files,
    write: (p, k, i, png) => {
      files.set(name(p, k, i), Buffer.from(png));
      return Promise.resolve();
    },
    read: (p, k, i, offset, length) => {
      const f = files.get(name(p, k, i));
      return Promise.resolve(f ? new Uint8Array(f.subarray(offset, offset + length)) : null);
    },
    has: (p, k) => Promise.resolve(files.has(name(p, k, 'full')) && files.has(name(p, k, 'thumbnail'))),
    remove: (p, k) => {
      files.delete(name(p, k, 'full'));
      files.delete(name(p, k, 'thumbnail'));
      return Promise.resolve();
    },
    removeAllExcept: (keep) => {
      for (const f of [...files.keys()]) {
        const [p, k] = f.split('/');
        if (!keep.has(`${p}/${k}`)) files.delete(f);
      }
      return Promise.resolve();
    },
  };
}

function setup(options: { budget?: Record<string, number>; artifactTtlMs?: number; renderer?: boolean } = {}) {
  const projectId = ProjectId.parse(randomUUID());
  const project: ProjectSummary = { projectId, name: 'P', root: '/design', boundAt: '2026-10-02T00:00:00.000Z' };
  const versions = new Versions();
  const store = memoryStore([project]);
  const renderer = new FakeRenderer();
  const images = memoryImages();
  const host: ProjectHost = {
    canonicalRoot: (p) => Promise.resolve(p),
    openRepo: () => versions.repo(),
    openListingRepo: () => Promise.reject(new Error('not used')),
    // Previews never read the folder: nothing on it is ever called.
    openWorkspace: () => ({}) as Workspace,
    createStaging: () => Promise.reject(new Error('not used')),
    clearOperationData: () => Promise.resolve(),
  };
  const core = createEngineCore(
    {
      clock: { nowIso: () => new Date().toISOString() },
      store,
      events: { publish: () => undefined },
      identity: {
        instanceId: EngineInstanceId.parse(randomUUID()),
        appVersion: 'test',
        startedAt: new Date().toISOString(),
        desktopIdentity: 'development',
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
      },
      host,
      ...(options.renderer === false ? {} : { previews: { renderer, images, timezone: 'Asia/Taipei' } }),
    },
    {
      previews: {
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.artifactTtlMs !== undefined ? { artifactTtlMs: options.artifactTtlMs } : {}),
      },
    },
  );
  const preview = (version: string, file?: string, channel: 'desktop' | 'cli' = 'desktop') =>
    core
      .handle(channel, 'snapshot.preview', { projectId, version, ...(file ? { file } : {}) })
      .then((a) => PreviewArtifact.parse(a));
  const read = async (artifactId: string, image: 'full' | 'thumbnail' = 'full', pid: string = projectId) => {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const c = (await core.handle('desktop', 'preview.read', {
        projectId: pid,
        artifactId,
        image,
        offset,
      })) as PreviewChunk;
      const b = Buffer.from(c.data, 'base64');
      parts.push(b);
      offset += b.length;
      if (c.done) return Buffer.concat(parts);
    }
  };
  const ports = { renderer, images, timezone: 'Asia/Taipei' };
  const ctx = createProjectContext({
    store,
    host,
    clock: { nowIso: () => new Date().toISOString() },
    events: { publish: () => undefined },
  });
  return { core, store, versions, renderer, images, projectId, preview, read, ctx, ports };
}

async function failure(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

const site = (projectId: string): Files => ({
  [PROJECT_CONFIG_FILE]: config(projectId, ['index.html']),
  'index.html': '<link rel="stylesheet" href="style.css"><img src="logo.png">',
  'style.css': 'body{color:red}',
  'logo.png': pngOf(64, 32),
});

describe('previews of a page', () => {
  it("renders the entry page of the version's own settings, serving only that version's files", async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    const art = await t.preview(v1.snapshotId);
    expect(art).toMatchObject({
      projectId: t.projectId,
      version: { commit: v1.commit, snapshotId: v1.snapshotId, seq: 1 },
      subject: { kind: 'page', path: 'index.html' },
      image: { width: 1280, height: 800 },
      thumbnail: { width: 400, height: 250 },
      cached: false,
      incomplete: true,
      settings: { viewport: { width: 1280, height: 800, scale: 1 }, locale: 'en-US', timezone: 'Asia/Taipei' },
    });
    expect(t.renderer.served).toEqual({
      '/index.html': 'ok',
      '/style.css': 'ok',
      '/logo.png': 'ok',
      '/missing.png': 'missing',
      '/%2e%2e/secret': 'missing',
    });
    expect(art.missing).toEqual({
      count: 2,
      entries: [
        { path: 'missing.png', reason: 'not-in-version' },
        { path: '../secret', reason: 'invalid-path' },
      ],
    });
    // Text from the page is made printable before it leaves.
    expect(art.blocked).toEqual({ count: 1, entries: [{ kind: 'network', target: 'https://fonts.example/�[31mx' }] });
    expect(t.renderer.jobs[0]).toMatchObject({ projectId: t.projectId, output: { width: 1280, height: 800 } });

    const png = await t.read(art.artifactId);
    expect(createHash('sha256').update(png).digest('hex')).toBe(art.image.sha256);
    expect((await t.read(art.artifactId, 'thumbnail')).length).toBe(art.thumbnail.bytes);
  });

  it('serves a second request, and a version with the same tree, from the cache', async () => {
    const t = setup();
    const files = site(t.projectId);
    const v1 = t.versions.add(files);
    t.versions.add({ ...files, 'style.css': 'body{color:blue}' });
    // A restore of V1: another commit, the same tree.
    const v3 = t.versions.add(files);
    const a = await t.preview(v1.snapshotId);
    const again = await t.preview(v1.commit);
    const restored = await t.preview(v3.snapshotId);
    expect(t.renderer.jobs).toHaveLength(1);
    expect(again).toMatchObject({ cached: true, image: a.image });
    expect(restored).toMatchObject({ cached: true, image: a.image, version: { seq: 3 } });
    expect(restored.artifactId).not.toBe(a.artifactId);
    await t.preview(t.versions.commits[1]?.oid ?? '');
    expect(t.renderer.jobs).toHaveLength(2);
  });

  it('renders once for requests that arrive together', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    let open: () => void = () => undefined;
    t.renderer.gate = new Promise((r) => (open = r));
    const both = Promise.all([t.preview(v1.snapshotId), t.preview(v1.snapshotId)]);
    await new Promise((r) => setTimeout(r, 20));
    open();
    const [a, b] = await both;
    expect(t.renderer.jobs).toHaveLength(1);
    expect(a.image.sha256).toBe(b.image.sha256);
  });

  it('runs the app’s renders before background ones, one at a time, and refuses an overfull queue', async () => {
    const t = setup();
    const service = createPreviewService(t.ctx, t.ports, { budget: { queue: 2 } });
    const vs = [1, 2, 3, 4].map((n) => t.versions.add({ ...site(t.projectId), 'style.css': `body{order:${n}}` }));
    const ref = (i: number) => vs[i]?.snapshotId ?? '';
    let open: () => void = () => undefined;
    t.renderer.gate = new Promise((r) => (open = r));
    const first = service.preview(t.projectId, ref(0));
    await new Promise((r) => setTimeout(r, 10));
    expect(service.status().queue).toEqual({ running: 1, waiting: 0 });
    // After a save: in the background. Then the app asks for another.
    service.warm(t.projectId, ref(1));
    await new Promise((r) => setTimeout(r, 10));
    const asked = service.preview(t.projectId, ref(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(service.status().queue).toEqual({ running: 1, waiting: 2 });
    expect(await failure(service.preview(t.projectId, ref(3)))).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'queue-full' },
      retryable: true,
    });
    open();
    await Promise.all([first, asked]);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.renderer.jobs).toHaveLength(3);
    // V3 (the app's) went before V2 (the background one).
    expect(t.renderer.order).toEqual([0, 2, 1].map((i) => `body{order:${i + 1}}`));
  });

  it('says why a version has no page to preview', async () => {
    const t = setup();
    const cases: [Files, string][] = [
      [{ 'index.html': 'x' }, 'no-settings'],
      [{ [PROJECT_CONFIG_FILE]: '{"schemaVersion":1}', 'index.html': 'x' }, 'settings-invalid'],
      [{ [PROJECT_CONFIG_FILE]: config(t.projectId, []), 'index.html': 'x' }, 'no-entry'],
      [{ [PROJECT_CONFIG_FILE]: config(t.projectId, ['index.html']) }, 'entry-missing'],
      [{ [PROJECT_CONFIG_FILE]: config(t.projectId, ['notes.md']), 'notes.md': '# x' }, 'entry-type'],
      [{ [PROJECT_CONFIG_FILE]: config(t.projectId, ['index.html']), 'index.html': { link: '/etc' } }, 'not-a-file'],
    ];
    for (const [files, reason] of cases) {
      const v = t.versions.add(files);
      expect(await failure(t.preview(v.snapshotId)), reason).toMatchObject({
        code: 'PREVIEW_UNSUPPORTED',
        details: { reason },
      });
    }
    expect(t.renderer.jobs).toHaveLength(0);
  });

  it('passes a failed render on, never caches it, and checks what the renderer sends back', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    t.renderer.fail = new DtError('PREVIEW_FAILED', 'took too long', { reason: 'timeout' }, true);
    expect(await failure(t.preview(v1.snapshotId))).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'timeout' },
    });
    t.renderer.fail = null;
    t.renderer.output = () => ({ full: { png: pngOf(1280, 799), width: 1280, height: 800 } });
    expect(await failure(t.preview(v1.snapshotId))).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'invalid-output' },
    });
    t.renderer.output = () => ({
      thumbnail: { png: new Uint8Array(Buffer.from('not a png')), width: 400, height: 250 },
    });
    expect(await failure(t.preview(v1.snapshotId))).toMatchObject({ details: { reason: 'invalid-output' } });
    expect(t.store.previews.size).toBe(0);
    t.renderer.output = () => ({});
    expect(await t.preview(v1.snapshotId)).toMatchObject({ cached: false });
  });

  it('answers no-renderer without a Preview Host, and still says what is unsupported', async () => {
    const t = setup({ renderer: false });
    const v1 = t.versions.add(site(t.projectId));
    expect(await failure(t.preview(v1.snapshotId))).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'no-renderer' },
      retryable: false,
    });
    const v2 = t.versions.add({ 'index.html': 'x' });
    expect(await failure(t.preview(v2.snapshotId))).toMatchObject({ details: { reason: 'no-settings' } });
    expect(await t.core.handle('desktop', 'preview.status', {})).toMatchObject({ available: false, renderer: null });
  });

  it('refuses references that are not versions of this project', async () => {
    const t = setup();
    t.versions.add(site(t.projectId));
    expect(await failure(t.preview(randomUUID()))).toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    expect(await failure(t.preview('HEAD'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(
      await failure(
        t.core.handle('desktop', 'snapshot.preview', { projectId: t.projectId, version: randomUUID(), force: true }),
      ),
    ).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('previews of an image', () => {
  it('fits a PNG or JPEG into the image box and serves the page nothing else', async () => {
    const t = setup();
    const v1 = t.versions.add({
      ...site(t.projectId),
      'art/hero.png': pngOf(2400, 900),
      'art/photo.jpg': jpegOf(300, 200, 5000),
    });
    const png = await t.preview(v1.snapshotId, 'art/hero.png');
    expect(png).toMatchObject({
      subject: { kind: 'image', path: 'art/hero.png', width: 2400, height: 900 },
      image: { width: 1600, height: 600 },
      thumbnail: { width: 400, height: 150 },
      missing: { count: 1, entries: [{ path: 'index.html', reason: 'not-in-version' }] },
    });
    expect(t.renderer.served['/art/hero.png']).toBe('ok');
    const jpeg = await t.preview(v1.snapshotId, 'art/photo.jpg');
    expect(jpeg).toMatchObject({ subject: { width: 300, height: 200 }, image: { width: 300, height: 200 } });
  });

  it('shares a preview between copies of the same image', async () => {
    const t = setup();
    const v1 = t.versions.add({ ...site(t.projectId), 'a.png': pngOf(10, 10), 'b/a-copy.png': pngOf(10, 10) });
    await t.preview(v1.snapshotId, 'a.png');
    const copy = await t.preview(v1.snapshotId, 'b/a-copy.png');
    expect(copy).toMatchObject({ cached: true, subject: { path: 'b/a-copy.png' } });
    expect(t.renderer.jobs).toHaveLength(1);
  });

  it('decodes nothing that is not a PNG or JPEG within the budget', async () => {
    const t = setup({ budget: { imagePixels: 1_000_000 } });
    const v = t.versions.add({
      ...site(t.projectId),
      'fake.png': 'GIF89a not really',
      'huge.png': pngOf(2000, 1000),
      'logo.svg': '<svg/>',
      'link.png': { link: 'a.png' },
    });
    const reasons: Record<string, string> = {
      'fake.png': 'image-invalid',
      'huge.png': 'image-too-large',
      'logo.svg': 'file-type',
      'link.png': 'not-a-file',
      'gone.png': 'file-missing',
    };
    for (const [file, reason] of Object.entries(reasons)) {
      expect(await failure(t.preview(v.snapshotId, file)), file).toMatchObject({
        code: 'PREVIEW_UNSUPPORTED',
        details: { reason },
      });
    }
    expect(await failure(t.preview(v.snapshotId, '../x.png'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('preview artifacts', () => {
  it('are bound to their project, expire, and read only within their PNG', async () => {
    const t = setup({ artifactTtlMs: 50 });
    const v1 = t.versions.add(site(t.projectId));
    const art = await t.preview(v1.snapshotId);
    expect(await failure(t.read(art.artifactId, 'full', randomUUID()))).toMatchObject({ code: 'PROJECT_NOT_BOUND' });
    const other = ProjectId.parse(randomUUID());
    t.store.insertProject({ projectId: other, name: 'Q', root: '/other', boundAt: '2026-10-02T00:00:00.000Z' });
    expect(await failure(t.read(art.artifactId, 'full', other))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'artifact-of-another-project' },
    });
    expect(await failure(t.read(randomUUID()))).toMatchObject({ details: { reason: 'unknown-artifact' } });
    expect(
      await failure(
        t.core.handle('desktop', 'preview.read', {
          projectId: t.projectId,
          artifactId: art.artifactId,
          image: 'full',
          offset: art.image.bytes + 1,
        }),
      ),
    ).toMatchObject({ details: { reason: 'offset' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(await failure(t.read(art.artifactId))).toMatchObject({ details: { reason: 'artifact-expired' } });
  });

  it('reads a large PNG in chunks that fit a control message', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    const big = Buffer.concat([pngOf(1280, 800), Buffer.alloc(1_300_000, 7)]);
    t.renderer.output = () => ({ full: { png: big, width: 1280, height: 800 } });
    const art = await t.preview(v1.snapshotId);
    const chunks: PreviewChunk[] = [];
    for (let offset = 0; ;) {
      const c = (await t.core.handle('desktop', 'preview.read', {
        projectId: t.projectId,
        artifactId: art.artifactId,
        image: 'full',
        offset,
      })) as PreviewChunk;
      chunks.push(c);
      offset += Buffer.from(c.data, 'base64').length;
      if (c.done) break;
    }
    expect(chunks.map((c) => c.offset)).toEqual([0, 524_288, 1_048_576]);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))).toEqual(big);
  });

  it('need agent access on the tool channel; the cache is the app’s', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    expect(await failure(t.preview(v1.snapshotId, undefined, 'cli'))).toMatchObject({ code: 'AGENT_ACCESS_DISABLED' });
    t.store.access = { enabled: true, updatedAt: null };
    expect(await t.preview(v1.snapshotId, undefined, 'cli')).toMatchObject({ cached: false });
    expect(await failure(t.core.handle('cli', 'preview.status', {}))).toMatchObject({ code: 'UNKNOWN_OPERATION' });
    expect(await failure(t.core.handle('mcp', 'preview.clearCache', {}))).toMatchObject({ code: 'UNKNOWN_OPERATION' });
  });
});

describe('the preview cache', () => {
  it('drops the least recently used previews beyond its budget, never the one just made', async () => {
    const t = setup({ budget: { cacheBytes: 120 } });
    const vs = [1, 2, 3].map((n) => t.versions.add({ ...site(t.projectId), 'style.css': `p{order:${n}}` }));
    for (const v of vs) {
      await t.preview(v.snapshotId);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Each preview's two PNGs are 98 bytes: only the newest fits.
    expect(t.store.listPreviews()).toHaveLength(1);
    expect(t.images.files.size).toBe(2);
    expect(await t.preview(vs[2]?.snapshotId ?? '')).toMatchObject({ cached: true });
    expect(await t.preview(vs[0]?.snapshotId ?? '')).toMatchObject({ cached: false });
  });

  it('renders again when a cached PNG is gone, and clears everything on request', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    await t.preview(v1.snapshotId);
    t.images.files.clear();
    expect(await t.preview(v1.snapshotId)).toMatchObject({ cached: false });
    expect(await t.core.handle('desktop', 'preview.status', {})).toMatchObject({
      available: true,
      cache: { entries: 1, bytes: 98 },
    });
    const art = await t.preview(v1.snapshotId);
    expect(await t.core.handle('desktop', 'preview.clearCache', {})).toEqual({ entries: 1, bytes: 98 });
    expect(t.images.files.size).toBe(0);
    expect(await failure(t.read(art.artifactId))).toMatchObject({ details: { reason: 'unknown-artifact' } });
  });

  it('sweeps PNGs no row names at start', async () => {
    const t = setup();
    const v1 = t.versions.add(site(t.projectId));
    await t.preview(v1.snapshotId);
    t.images.files.set(`${t.projectId}/${'f'.repeat(64)}/full`, Buffer.from('orphan'));
    await t.core.startup();
    expect([...t.images.files.keys()].filter((k) => k.includes('f'.repeat(64)))).toEqual([]);
    expect(t.images.files.size).toBe(2);
  });
});

describe('serving files to a render', () => {
  const entries = (files: Record<string, number | 'link'>): Map<string, GitTreeEntry> =>
    new Map(
      Object.entries(files).map(([path, size]) => [
        path,
        {
          path,
          mode: size === 'link' ? '120000' : '100644',
          type: 'blob',
          oid: sha1(path),
          size: size === 'link' ? 5 : size,
        },
      ]),
    );
  const repo = { streamBlob: (oid: string) => chunksOf([new Uint8Array(Buffer.from(`bytes of ${oid}`))]) };
  const budget = { fileBytes: 100, totalBytes: 150, requests: 6 };

  it('serves regular files of a type previews use, by exact name or its other Unicode form', async () => {
    const nfd = 'café.css'.normalize('NFD');
    const src = createFileSource(
      repo,
      entries({ 'a b/x.html': 10, [nfd]: 10, '.htaccess': 10, 'data.bin': 10 }),
      budget,
    );
    expect(await src.read('/a%20b/x.html')).toMatchObject({ status: 'ok', contentType: 'text/html; charset=utf-8' });
    expect(await src.read(`/${encodeURIComponent('café.css'.normalize('NFC'))}`)).toMatchObject({ status: 'ok' });
    expect(await src.read('/.htaccess')).toEqual({ status: 'missing' });
    expect(await src.read('/data.bin')).toEqual({ status: 'missing' });
    expect(src.report().missing.entries.map((m) => m.reason)).toEqual(['type', 'type']);
  });

  it('refuses paths outside the version and anything over its budgets', async () => {
    const src = createFileSource(repo, entries({ 'a.css': 60, 'b.css': 60, 'big.css': 101, 'l.css': 'link' }), {
      ...budget,
      requests: 100,
    });
    const answers = [];
    for (const p of [
      '/%2e%2e/x.css',
      '/a%2f..%2f..%2fx.css',
      '/%5cetc',
      '/%E0%A4%A',
      '/',
      '/.git/config',
      '/l.css',
      '/big.css',
      '/a.css',
      '/b.css',
      '/a.css',
    ]) {
      answers.push((await src.read(p)).status);
    }
    expect(answers).toEqual([
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'ok',
      'ok',
      'missing',
    ]);
    expect(src.report()).toMatchObject({ requests: 11, servedBytes: expect.any(Number) as number });
    expect(src.report().missing.entries.map((m) => m.reason)).toEqual([
      'invalid-path',
      'invalid-path',
      'invalid-path',
      'invalid-path',
      'invalid-path',
      'invalid-path',
      'not-a-file',
      'too-large',
      'budget',
    ]);
  });

  it('counts every request, keeps 20 samples, and stops serving past the request budget', async () => {
    const src = createFileSource(repo, entries({ 'a.css': 1 }), { ...budget, requests: 25 });
    for (let i = 0; i < 30; i++) await src.read(`/missing-${i}\u0007.css`);
    expect(await src.read('/a.css')).toEqual({ status: 'missing' });
    const { missing } = src.report();
    expect(missing.count).toBe(31);
    expect(missing.entries).toHaveLength(20);
    expect(missing.entries[0]?.path).toBe('missing-0�.css');
  });

  it('decodes a path once and accepts only a safe relative one', () => {
    expect(decodePreviewPath('/css/a%20b.css')).toBe('css/a b.css');
    expect(decodePreviewPath('/%252e%252e/x')).toBe('%2e%2e/x');
    for (const bad of ['/%2e%2e/x', '/x/%2e/y', '/%00', '/C%3A/x', '/a//b', '/.GIT/HEAD', '/%']) {
      expect(decodePreviewPath(bad), bad).toBeNull();
    }
  });
});

describe('image headers', () => {
  it('reads PNG and JPEG sizes, past JPEG segments and fill bytes', () => {
    expect(imageInfo(pngOf(2400, 900))).toEqual({ format: 'png', width: 2400, height: 900 });
    expect(imageInfo(jpegOf(640, 480, 60_000))).toEqual({ format: 'jpeg', width: 640, height: 480 });
  });

  it('refuses headers that lie or stop short', () => {
    const png = pngOf(10, 10);
    expect(imageInfo(png.subarray(0, 20))).toBeNull();
    expect(imageInfo(pngOf(0, 10))).toBeNull();
    const notIhdr = Buffer.from(png);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(imageInfo(notIhdr)).toBeNull();
    const jpeg = jpegOf(10, 10);
    expect(imageInfo(jpeg.subarray(0, 10))).toBeNull();
    expect(imageInfo(jpegOf(0, 10))).toBeNull();
    // A segment length running past the end.
    const long = Buffer.from(jpeg);
    long.writeUInt16BE(0xfff0, 4);
    expect(imageInfo(long)).toBeNull();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
  });

  it('never throws on any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.boolean(), (bytes, asJpeg) => {
        const b = asJpeg ? Buffer.concat([Buffer.from([0xff, 0xd8]), bytes]) : Buffer.from(bytes);
        const info = imageInfo(b);
        if (info) expect(info.width * info.height).toBeGreaterThan(0);
      }),
    );
  });

  it('fits without enlarging, keeping the aspect ratio', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 20_000 }), (w, h) => {
        const box = { width: 1600, height: 1600 };
        const out = fitWithin({ width: w, height: h }, box);
        expect(out.width).toBeLessThanOrEqual(Math.min(w, box.width));
        expect(out.height).toBeLessThanOrEqual(Math.min(h, box.height));
        expect(out.width).toBeGreaterThanOrEqual(1);
        if (w <= 1600 && h <= 1600) expect(out).toEqual({ width: w, height: h });
        // Each side is rounded once (by at most half a pixel, or up to 1).
        else expect(Math.abs(out.width * h - out.height * w)).toBeLessThanOrEqual(w + h);
      }),
    );
  });
});
