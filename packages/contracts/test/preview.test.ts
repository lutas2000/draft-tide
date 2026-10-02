import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EngineToHost,
  HostToEngine,
  OPERATIONS,
  PREVIEW_FAILED_REASONS,
  PREVIEW_READ_CHUNK_BYTES,
  PreviewArtifact,
  PreviewChunk,
  PreviewHostLaunch,
  PreviewReadInput,
  RETRYABLE_PREVIEW_FAILURES,
  SnapshotPreviewInput,
  previewContentType,
  previewKindOf,
  previewRendererId,
} from '../src/index.ts';

const settings = {
  viewport: { width: 1280, height: 800, scale: 1 },
  thumbnail: { width: 400, height: 250 },
  locale: 'en-US',
  timezone: 'Asia/Taipei',
  scripts: true,
  wait: 'load+fonts+2-frames+300ms',
  animations: 'jump-to-end',
};
const image = { width: 1280, height: 800, bytes: 10, sha256: 'a'.repeat(64) };

function artifact(over: Record<string, unknown> = {}) {
  return {
    artifactId: randomUUID(),
    projectId: randomUUID(),
    expiresAt: '2026-10-02T00:30:00.000Z',
    version: { commit: 'b'.repeat(40), snapshotId: randomUUID(), seq: 2, title: 'Pricing' },
    subject: { kind: 'page', path: 'index.html' },
    image,
    thumbnail: { ...image, width: 400, height: 250 },
    renderedAt: '2026-10-02T00:00:00.000Z',
    cached: false,
    missing: { count: 0, entries: [] },
    blocked: { count: 0, entries: [] },
    incomplete: false,
    settings,
    environment: {
      renderer: 'electron/1 chromium/2',
      electron: '1',
      chromium: '2',
      platform: 'darwin',
      osRelease: '27',
    },
    ...over,
  };
}

describe('preview operations', () => {
  it('give the tool channel previews with agent access; the cache stays the app’s', () => {
    expect(OPERATIONS['snapshot.preview']).toMatchObject({ desktop: true, tool: 'agent-access', effect: 'read' });
    expect(OPERATIONS['preview.read']).toMatchObject({ desktop: true, tool: 'agent-access', effect: 'read' });
    expect(OPERATIONS['preview.status']).toMatchObject({ desktop: true, tool: 'none' });
    expect(OPERATIONS['preview.clearCache']).toMatchObject({ desktop: true, tool: 'none', effect: 'write' });
  });

  it('take a version reference and, for an image, a safe path; nothing self-asserted', () => {
    const projectId = randomUUID();
    const version = randomUUID();
    expect(SnapshotPreviewInput.safeParse({ projectId, version }).success).toBe(true);
    expect(SnapshotPreviewInput.safeParse({ projectId, version, file: 'art/hero.png' }).success).toBe(true);
    for (const bad of [
      { projectId, version: 'HEAD' },
      { projectId, version, file: '../hero.png' },
      { projectId, version, file: '/etc/hosts' },
      { projectId, version, file: '.git/config' },
      { projectId, version, force: true },
      { projectId, version, viewport: { width: 4000 } },
    ]) {
      expect(SnapshotPreviewInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const artifactId = randomUUID();
    expect(PreviewReadInput.safeParse({ projectId, artifactId, image: 'full' }).success).toBe(true);
    expect(PreviewReadInput.safeParse({ projectId, artifactId, image: 'source' }).success).toBe(false);
    expect(PreviewReadInput.safeParse({ projectId, artifactId, image: 'full', offset: -1 }).success).toBe(false);
    expect(PreviewReadInput.safeParse({ projectId, artifactId, image: 'full', path: '/etc/hosts' }).success).toBe(
      false,
    );
  });

  it('describe an artifact strictly: a reference, never a path', () => {
    expect(PreviewArtifact.safeParse(artifact()).success).toBe(true);
    expect(PreviewArtifact.safeParse(artifact({ path: '/Users/x/cache/a.png' })).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `m${i}.png`, reason: 'not-in-version' }));
    expect(PreviewArtifact.safeParse(artifact({ missing: { count: 21, entries: many } })).success).toBe(false);
    expect(
      PreviewArtifact.safeParse(
        artifact({ blocked: { count: 1, entries: [{ kind: 'network', target: 'x'.repeat(201) }] } }),
      ).success,
    ).toBe(false);
  });

  it('read PNGs in chunks that fit one control message', () => {
    const data = Buffer.alloc(PREVIEW_READ_CHUNK_BYTES).toString('base64');
    const chunk = { artifactId: randomUUID(), image: 'full', offset: 0, size: 1, data, done: true };
    expect(PreviewChunk.safeParse(chunk).success).toBe(true);
    expect(JSON.stringify(chunk).length).toBeLessThan(1024 * 1024);
    expect(PreviewChunk.safeParse({ ...chunk, data: `${data}AAAA` }).success).toBe(false);
  });

  it('call only some failures retryable', () => {
    expect([...RETRYABLE_PREVIEW_FAILURES].every((r) => PREVIEW_FAILED_REASONS.includes(r))).toBe(true);
    expect(RETRYABLE_PREVIEW_FAILURES.has('no-renderer')).toBe(false);
    expect(RETRYABLE_PREVIEW_FAILURES.has('timeout')).toBe(true);
  });
});

describe('what previews serve', () => {
  it('know types by extension, case-insensitively, and nothing else', () => {
    expect(previewContentType('index.HTML')).toBe('text/html; charset=utf-8');
    expect(previewContentType('a/b.woff2')).toBe('font/woff2');
    expect(previewContentType('photo.JPEG')).toBe('image/jpeg');
    for (const p of [
      '.htaccess',
      'Makefile',
      'a.exe',
      'x.php',
      'a.constructor',
      'b.__proto__',
      'c.toString',
      'dir.css/',
    ]) {
      expect(previewContentType(p), p).toBeNull();
    }
  });

  it('preview HTML pages and PNG/JPEG images', () => {
    expect(previewKindOf('index.html')).toBe('page');
    expect(previewKindOf('pages/about.htm')).toBe('page');
    expect(previewKindOf('art/logo.PNG')).toBe('image');
    expect(previewKindOf('art/photo.jpg')).toBe('image');
    expect(previewKindOf('art/logo.svg')).toBeNull();
    expect(previewKindOf('.html')).toBeNull();
  });
});

describe('the Preview Host pipe', () => {
  const jobId = randomUUID();
  it('carries a job with exact output sizes, and file answers', () => {
    const job = {
      type: 'job',
      jobId,
      subject: { kind: 'page', path: 'index.html' },
      settings,
      output: { width: 1280, height: 800 },
      thumbnail: { width: 400, height: 250 },
      timeoutMs: 20_000,
    };
    expect(EngineToHost.parse(job)).toEqual(job);
    expect(EngineToHost.safeParse({ ...job, dataDir: '/x' }).success).toBe(false);
    expect(
      EngineToHost.safeParse({ type: 'file', jobId, requestId: 3, status: 'ok', contentType: 'text/css' }).success,
    ).toBe(true);
    expect(EngineToHost.safeParse({ type: 'shell', command: 'id' }).success).toBe(false);
  });

  it('accepts only the host’s four messages back', () => {
    expect(HostToEngine.safeParse({ type: 'fetch', jobId, requestId: 0, path: '/index.html' }).success).toBe(true);
    expect(HostToEngine.safeParse({ type: 'fetch', jobId, requestId: 0, path: 'x'.repeat(8193) }).success).toBe(false);
    expect(
      HostToEngine.safeParse({ type: 'done', jobId, outcome: 'captured', blocked: { count: 0, entries: [] } }).success,
    ).toBe(true);
    expect(
      HostToEngine.safeParse({ type: 'done', jobId, outcome: 'saved-anyway', blocked: { count: 0, entries: [] } })
        .success,
    ).toBe(false);
    expect(HostToEngine.safeParse({ type: 'request', op: 'agentAccess.set' }).success).toBe(false);
  });

  it('names the renderer the same way on both sides', () => {
    expect(previewRendererId('44.5.1', '152.0.7977.130')).toBe('electron/44.5.1 chromium/152.0.7977.130');
    expect(PreviewHostLaunch.safeParse({ command: '/a/Electron', args: ['/a/main.mjs'], renderer: 'r' }).success).toBe(
      true,
    );
    expect(PreviewHostLaunch.safeParse({ command: '/a/Electron', args: [], renderer: 'r', env: {} }).success).toBe(
      false,
    );
  });
});
