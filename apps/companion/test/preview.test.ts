// Previews through a real Engine, Git, filesystem and SQLite, with the
// scripted Preview Host (fake-preview-host.ts): what is rendered comes from
// the version in Git, never the folder; nothing is written to the folder or
// its repo; the PNGs live in the data directory's cache; the CLI and MCP get
// the same artifacts behind agent access. The real Electron host and its
// isolation are checked in the desktop E2E.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DtError,
  PREVIEW_HOST_ENV,
  previewRendererId,
  type PreviewArtifact,
  type PreviewChunk,
  type ProjectId,
} from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  digestTree,
  gitStatus,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, COMPANION, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';
import { makePng } from './png.ts';

const FAKE_HOST = join(COMPANION, 'test', 'fake-preview-host.ts');
const HOST = JSON.stringify({
  command: process.execPath,
  args: [FAKE_HOST, '--mode=render'],
  renderer: previewRendererId('1.0.0', '2.0.0'),
});

const dataDir = tempDataDir();
let desktop: EngineConnection;

beforeAll(async () => {
  desktop = await connectTo(dataDir, 'desktop', 5_000, { [PREVIEW_HOST_ENV]: HOST });
});

afterAll(async () => {
  desktop?.close();
  await cleanupDataDirs();
  cleanupTempDirs();
});

async function failure(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const PAGE = '<link href="css/site.css"><img src="img/hero.png"><img src="img/missing.png">';

async function project(entryFiles = ['index.html'], page = PAGE): Promise<{ root: string; projectId: ProjectId }> {
  const root = tempDir('dt-preview-');
  write(root, 'index.html', `${page}<script src="https://cdn.example/app.js"></script>`);
  write(root, 'css/site.css', 'body { margin: 0 }');
  write(root, 'img/hero.png', makePng(2400, 900));
  const review = await desktop.call('project.review', { root });
  const bound = await desktop.call('project.bind', {
    root,
    name: 'Preview',
    entryFiles,
    reviewToken: review.reviewToken,
  });
  return { root, projectId: bound.project.projectId };
}

const save = (projectId: ProjectId, name?: string) =>
  desktop.call('snapshot.create', { projectId, ...(name ? { name } : {}) });

async function readAll(conn: EngineConnection, art: PreviewArtifact, image: 'full' | 'thumbnail' = 'full') {
  const parts: Buffer[] = [];
  for (let offset = 0; ;) {
    const c: PreviewChunk = await conn.call('preview.read', {
      projectId: art.projectId,
      artifactId: art.artifactId,
      image,
      offset,
    });
    const b = Buffer.from(c.data, 'base64');
    parts.push(b);
    offset += b.length;
    if (c.done) return Buffer.concat(parts);
  }
}

describe('previews on a real Engine', () => {
  it('renders a version from Git, writing nothing to the folder or its repo', async () => {
    const { root, projectId } = await project();
    const v1 = await save(projectId, 'First');
    const before = digestTree(root);
    const art = await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId });
    expect(art).toMatchObject({
      version: { snapshotId: v1.snapshotId, seq: 1, title: 'First' },
      subject: { kind: 'page', path: 'index.html' },
      image: { width: 1280, height: 800 },
      thumbnail: { width: 400, height: 250 },
      missing: { count: 1, entries: [{ path: 'img/missing.png', reason: 'not-in-version' }] },
      blocked: { count: 1, entries: [{ kind: 'network', target: 'https://cdn.example/app.js' }] },
      incomplete: true,
      settings: { viewport: { width: 1280, height: 800, scale: 1 } },
      environment: { renderer: previewRendererId('1.0.0', '2.0.0') },
    });
    // The folder and its .git (index, refs, objects…) are as they were.
    expect(digestTree(root)).toEqual(before);
    expect(gitStatus(root)).toBe('');
    // The PNGs are in the data directory's rebuildable cache, nowhere else.
    const cache = join(dataDir, 'projects', projectId, 'cache', 'previews');
    expect(readdirSync(cache).sort()).toHaveLength(2);
    const png = await readAll(desktop, art);
    expect(createHash('sha256').update(png).digest('hex')).toBe(art.image.sha256);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });

  it('shows what each version holds, not what the folder holds now', async () => {
    const { root, projectId } = await project();
    const v1 = await save(projectId);
    // Unsaved: the page now asks for another file.
    write(root, 'index.html', '<link href="css/extra.css">');
    const a = await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId });
    expect(a.missing.entries.map((m) => m.path)).toEqual(['img/missing.png']);
    const v2 = await save(projectId);
    const b = await desktop.call('snapshot.preview', { projectId, version: v2.snapshotId });
    expect(b.missing.entries.map((m) => m.path)).toEqual(['css/extra.css']);
    expect(b.blocked.count).toBe(0);
  });

  it('makes the thumbnail after a save, in the background, and shares it with a restore of that version', async () => {
    const { root, projectId } = await project();
    const v1 = await save(projectId);
    await expect
      .poll(async () => (await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId })).cached, {
        timeout: 10_000,
      })
      .toBe(true);
    write(root, 'css/site.css', 'body { margin: 4px }');
    await save(projectId);
    const plan = await desktop.call('restore.plan', { projectId, target: v1.snapshotId });
    const restored = await desktop.call('restore.apply', { projectId, planId: plan.planId });
    const art = await desktop.call('snapshot.preview', { projectId, version: restored.restored.commit });
    // The restore version's tree is V1's: the same picture, from the cache.
    expect(art).toMatchObject({ cached: true, version: { seq: 3 } });
  });

  it('previews a PNG of a version, fitted, and says what can’t be previewed', async () => {
    const { projectId } = await project([]);
    const v1 = await save(projectId);
    expect(
      await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId, file: 'img/hero.png' }),
    ).toMatchObject({
      subject: { kind: 'image', path: 'img/hero.png', width: 2400, height: 900 },
      image: { width: 1600, height: 600 },
      thumbnail: { width: 400, height: 150 },
    });
    expect(await failure(desktop.call('snapshot.preview', { projectId, version: v1.snapshotId }))).toMatchObject({
      code: 'PREVIEW_UNSUPPORTED',
      details: { reason: 'no-entry' },
    });
    expect(
      await failure(desktop.call('snapshot.preview', { projectId, version: v1.snapshotId, file: 'css/site.css' })),
    ).toMatchObject({ code: 'PREVIEW_UNSUPPORTED', details: { reason: 'file-type' } });
  });

  it('previews other tools’ commits by their commit id', async () => {
    const { root, projectId } = await project();
    await save(projectId);
    write(root, 'css/site.css', 'body { margin: 8px }');
    plainGit(root, ['add', '-A']);
    plainGit(root, ['commit', '--quiet', '-m', 'Engineer tweak']);
    const commit = plainGit(root, ['rev-parse', 'HEAD']).trim();
    expect(await desktop.call('snapshot.preview', { projectId, version: commit })).toMatchObject({
      version: { commit, snapshotId: null, seq: null, title: 'Engineer tweak' },
    });
  });

  it('clears the cache on request; previews are rebuilt when asked for', async () => {
    const { projectId } = await project();
    const v1 = await save(projectId);
    await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId });
    const status = await desktop.call('preview.status', {});
    expect(status).toMatchObject({ available: true, renderer: previewRendererId('1.0.0', '2.0.0') });
    expect(status.cache.entries).toBeGreaterThan(0);
    const cleared = await desktop.call('preview.clearCache', {});
    expect(cleared.entries).toBe(status.cache.entries);
    expect(readdirSync(join(dataDir, 'projects', projectId, 'cache', 'previews'))).toEqual([]);
    expect(await desktop.call('snapshot.preview', { projectId, version: v1.snapshotId })).toMatchObject({
      cached: false,
    });
  });
});

describe('previews from the CLI and MCP', () => {
  it('need agent access, then write the PNG the artifact names (never over a file)', async () => {
    const { projectId } = await project();
    const v1 = await save(projectId);
    const out = join(tempDir('dt-preview-out-'), 'v1.png');
    const off = cli('--json', '--project', projectId, 'preview', v1.snapshotId, '--out', out);
    expect(off.status).toBe(1);
    expect(JSON.parse(off.stdout)).toMatchObject({ ok: false, error: { code: 'AGENT_ACCESS_DISABLED' } });
    expect(existsSync(out)).toBe(false);

    await desktop.call('agentAccess.set', { enabled: true });
    const r = cli('--json', '--project', projectId, 'preview', v1.snapshotId, '--out', out);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: PreviewArtifact & { out: { path: string; bytes: number } };
    };
    expect(env.data).toMatchObject({ out: { path: out, image: 'full' }, image: { width: 1280, height: 800 } });
    expect(createHash('sha256').update(readFileSync(out)).digest('hex')).toBe(env.data.image.sha256);
    const again = cli('--json', '--project', projectId, 'preview', v1.snapshotId, '--out', out);
    expect(again.status).toBe(2);
    expect(JSON.parse(again.stdout)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

    const thumb = join(tempDir('dt-preview-out-'), 'thumb.png');
    expect(cli('--project', projectId, 'preview', v1.snapshotId, '--out', thumb, '--thumbnail').status).toBe(0);
    expect(readFileSync(thumb).readUInt32BE(16)).toBe(400);

    const human = cli('--project', projectId, 'preview', v1.snapshotId);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/Preview of V1/);
    expect(human.stdout).toMatch(/Missing \(1\): img\/missing\.png \[not-in-version\]/);
    expect(human.stdout).toMatch(/Blocked \(1\): network https:\/\/cdn\.example\/app\.js/);

    const unsupported = cli('--json', '--project', projectId, 'preview', v1.snapshotId, '--file', 'css/site.css');
    expect(unsupported.status).toBe(1);
    expect(JSON.parse(unsupported.stdout)).toMatchObject({
      error: { code: 'PREVIEW_UNSUPPORTED', details: { reason: 'file-type' } },
    });
    expect(cli('--json', '--project', projectId, 'preview', 'HEAD').status).toBe(2);
    await desktop.call('agentAccess.set', { enabled: false });
  });

  it('gives MCP the same artifact and PNG', async () => {
    const { projectId } = await project();
    const v1 = await save(projectId);
    await desktop.call('agentAccess.set', { enabled: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_SOURCE, '--data-dir', dataDir, 'mcp', 'serve'],
      env: { ...(process.env as Record<string, string>), DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'draft-tide-test', version: '0' });
    await client.connect(transport);
    const envelopeOf = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? '') as {
        ok: boolean;
        data: Record<string, unknown>;
      };
    const result = await client.callTool({
      name: 'snapshot_preview',
      arguments: { projectId, version: v1.snapshotId },
    });
    expect(result.isError).toBe(false);
    const art = envelopeOf(result).data as unknown as PreviewArtifact;
    expect(art).toMatchObject({ projectId, image: { width: 1280 } });
    const chunk = envelopeOf(
      await client.callTool({
        name: 'preview_read',
        arguments: { projectId, artifactId: art.artifactId, image: 'thumbnail' },
      }),
    ).data as unknown as PreviewChunk;
    expect(chunk).toMatchObject({ done: true, size: art.thumbnail.bytes });
    await client.close();
    await desktop.call('agentAccess.set', { enabled: false });
  });
});

describe('an Engine without a Preview Host', () => {
  it('says previews are unavailable and keeps everything else working', async () => {
    const other = tempDataDir();
    const conn = await connectTo(other, 'desktop', 2_000);
    const root = tempDir('dt-preview-');
    write(root, 'index.html', '<h1>x</h1>');
    const review = await conn.call('project.review', { root });
    const { project: p } = await conn.call('project.bind', {
      root,
      name: 'No host',
      entryFiles: ['index.html'],
      reviewToken: review.reviewToken,
    });
    const v1 = await conn.call('snapshot.create', { projectId: p.projectId });
    expect(
      await failure(conn.call('snapshot.preview', { projectId: p.projectId, version: v1.snapshotId })),
    ).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'no-renderer' },
      retryable: false,
    });
    expect(await conn.call('preview.status', {})).toMatchObject({ available: false, renderer: null });
    expect(await conn.call('history.list', { projectId: p.projectId })).toMatchObject({ versions: 1 });
    conn.close();
  });
});
