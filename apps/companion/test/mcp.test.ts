// The MCP server against a real Engine, Git, filesystem and SQLite (M1 plan
// §13.2): the same fixture through MCP and the CLI gives the same versions and
// diffs; previews come back as image content; the access switch, strict
// inputs and plan ownership hold through the host's validation; stdout is
// protocol only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  PREVIEW_HOST_ENV,
  previewRendererId,
  type HistoryPage,
  type PreviewArtifact,
  type ProjectId,
  type RestorePlan,
  type RestoreResult,
  type SavedSnapshot,
  type SnapshotDiff,
} from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir, write } from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, COMPANION, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';
import { makePng } from './png.ts';

const HOST = JSON.stringify({
  command: process.execPath,
  args: [join(COMPANION, 'test', 'fake-preview-host.ts'), '--mode=render'],
  renderer: previewRendererId('1.0.0', '2.0.0'),
});

const dataDir = tempDataDir();
let desktop: EngineConnection;
let client: Client;

interface Env<T> {
  ok: boolean;
  data: T;
  warnings: { code: string }[];
  error: { code: string; details: Record<string, unknown> } | null;
}
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface Result<T> {
  isError: boolean;
  content: Content[];
  envelope: Env<T>;
}

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Content[] };
  const first = r.content[0];
  if (first?.type !== 'text') throw new Error('the envelope must come first');
  return { isError: r.isError ?? false, content: r.content, envelope: JSON.parse(first.text) as Env<T> };
}

function cli(...args: string[]): Env<unknown> {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--json', '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    timeout: 30_000,
  });
  return JSON.parse(r.stdout) as Env<unknown>;
}

beforeAll(async () => {
  desktop = await connectTo(dataDir, 'desktop', 5_000, { [PREVIEW_HOST_ENV]: HOST });
  await desktop.call('agentAccess.set', { enabled: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_SOURCE, '--data-dir', dataDir, 'mcp', 'serve'],
    env: { ...(process.env as Record<string, string>), DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    stderr: 'ignore',
  });
  client = new Client({ name: 'draft-tide-test', version: '0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  desktop?.close();
  await cleanupDataDirs();
  cleanupTempDirs();
});

async function project(name: string): Promise<{ root: string; projectId: ProjectId }> {
  const root = tempDir('dt-mcp-');
  write(root, 'index.html', '<link href="site.css"><h1>one</h1>\n');
  write(root, 'site.css', 'h1 { color: red }\n');
  write(root, 'hero.png', makePng(64, 32));
  const review = await desktop.call('project.review', { root });
  const bound = await desktop.call('project.bind', {
    root,
    name,
    entryFiles: ['index.html'],
    reviewToken: review.reviewToken,
  });
  return { root, projectId: bound.project.projectId };
}

describe('MCP on a real Engine', () => {
  it('saves, lists, compares and restores with the versions the CLI sees', async () => {
    const { root, projectId } = await project('Site');
    const v1 = await call<SavedSnapshot>('snapshot_create', { projectId, name: 'First' });
    expect(v1.isError).toBe(false);
    expect(v1.envelope.data).toMatchObject({ kind: 'baseline', origin: 'mcp', files: 4 });
    write(root, 'index.html', '<link href="site.css"><h1>two</h1>\n');
    write(root, 'site.css', 'h1 { color: blue }\n');
    const v2 = await call<SavedSnapshot>('snapshot_create', { projectId, name: 'Second' });
    expect(v2.envelope.data).toMatchObject({ kind: 'agent-requested', origin: 'mcp' });

    // The same history and diff through both tool channels.
    const history = await call<HistoryPage>('history_list', { projectId });
    const ids = history.envelope.data.entries.map((e) => e.snapshot?.snapshotId);
    expect(ids).toEqual([v2.envelope.data.snapshotId, v1.envelope.data.snapshotId]);
    expect(history.envelope.data.entries[0]?.snapshot).toMatchObject({ origin: 'mcp', kind: 'agent-requested' });
    const fromCli = cli('--project', projectId, 'history') as Env<HistoryPage>;
    expect(fromCli.data.entries.map((e) => e.snapshot?.snapshotId)).toEqual(ids);

    const [a, b] = [v1.envelope.data.snapshotId, v2.envelope.data.snapshotId];
    const diff = await call<SnapshotDiff>('snapshot_diff', { projectId, from: a, to: b });
    expect(diff.envelope.data.summary).toMatchObject({ total: 2, modified: 2 });
    expect(cli('--project', projectId, 'diff', a, b).data).toEqual(diff.envelope.data);
    const file = await call<{ kind: string; hunks: { lines: string[] }[] }>('snapshot_diff_file', {
      projectId,
      from: a,
      to: b,
      path: 'site.css',
    });
    expect(file.envelope.data.kind).toBe('text');
    expect(file.envelope.data.hunks[0]?.lines).toEqual(['-h1 { color: red }', '+h1 { color: blue }']);

    // Nothing to save is not a broken tool.
    const same = await call('snapshot_create', { projectId });
    expect(same.isError).toBe(false);
    expect(same.envelope.error?.code).toBe('NO_CHANGES');

    // Restore: plan, then apply; the folder is at V1 again, with no
    // protection version (nothing was unsaved).
    const plan = await call<RestorePlan>('restore_plan', { projectId, target: a });
    expect(plan.envelope.data).toMatchObject({ summary: { overwrite: 2 }, protection: { needed: false } });
    const done = await call<RestoreResult>('restore_apply', { projectId, planId: plan.envelope.data.planId });
    expect(done.isError).toBe(false);
    expect(done.envelope.data).toMatchObject({ written: 2, deleted: 0, protection: null, target: { snapshotId: a } });
    expect(readFileSync(join(root, 'site.css'), 'utf8')).toBe('h1 { color: red }\n');
    // A plan is applied once.
    const again = await call('restore_apply', { projectId, planId: plan.envelope.data.planId });
    expect(again.isError).toBe(true);
    expect(again.envelope.error).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'used' } });

    // Unsaved changes are protected first, and the result says where.
    write(root, 'index.html', '<h1>unsaved</h1>\n');
    const plan2 = await call<RestorePlan>('restore_plan', { projectId, target: b });
    expect(plan2.envelope.data.protection).toMatchObject({ needed: true, unsavedChanges: 1 });
    const done2 = await call<RestoreResult>('restore_apply', { projectId, planId: plan2.envelope.data.planId });
    expect(done2.envelope.data.protection?.snapshotId).toBeTruthy();
    expect(done2.envelope.data.restored?.snapshotId).toBeTruthy();
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<link href="site.css"><h1>two</h1>\n');
    const after = cli('--project', projectId, 'history') as Env<HistoryPage>;
    expect(after.data.entries.slice(0, 2).map((e) => e.snapshot?.kind)).toEqual(['restore', 'pre-restore']);
    expect(after.data.entries[0]?.snapshot?.origin).toBe('mcp');
  });

  it('refuses self-asserted flags, plans of another project and stale plans as the Engine does', async () => {
    const one = await project('One');
    const two = await project('Two');
    // The host's schema lets unknown fields through; the Engine refuses them.
    const flagged = await call('snapshot_create', { projectId: one.projectId, name: 'x', confirmed: true });
    expect(flagged.isError).toBe(true);
    expect(flagged.envelope.error?.code).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify(flagged.envelope.error?.details)).toMatch(/confirmed/);

    const v1 = await call<SavedSnapshot>('snapshot_create', { projectId: one.projectId, name: 'First' });
    await call('snapshot_create', { projectId: two.projectId, name: 'First' });
    write(one.root, 'index.html', '<h1>changed</h1>\n');
    await call('snapshot_create', { projectId: one.projectId, name: 'Second' });
    const plan = await call<RestorePlan>('restore_plan', {
      projectId: one.projectId,
      target: v1.envelope.data.snapshotId,
    });
    const planId = plan.envelope.data.planId;
    const forced = await call('restore_apply', { projectId: one.projectId, planId, force: true });
    expect(forced.envelope.error?.code).toBe('INVALID_ARGUMENT');
    const crossed = await call('restore_apply', { projectId: two.projectId, planId });
    expect(crossed.envelope.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'plan-of-another-project' },
    });
    // The folder changed since the plan: nothing is written.
    write(one.root, 'site.css', 'h1 { color: green }\n');
    const stale = await call('restore_apply', { projectId: one.projectId, planId: plan.envelope.data.planId });
    expect(stale.isError).toBe(true);
    expect(stale.envelope.error?.code).toBe('PLAN_STALE');
    expect(readFileSync(join(one.root, 'index.html'), 'utf8')).toBe('<h1>changed</h1>\n');
  });

  it('attaches the preview as image content, checked against the artifact', async () => {
    const { projectId } = await project('Pictures');
    const v1 = await call<SavedSnapshot>('snapshot_create', { projectId, name: 'First' });
    const id = v1.envelope.data.snapshotId;

    const full = await call<PreviewArtifact>('snapshot_preview', { projectId, version: id });
    expect(full.isError).toBe(false);
    expect(full.envelope.warnings).toEqual([]);
    expect(full.content).toHaveLength(2);
    const image = full.content[1];
    if (image?.type !== 'image') throw new Error('expected image content');
    expect(image.mimeType).toBe('image/png');
    const png = Buffer.from(image.data, 'base64');
    expect(createHash('sha256').update(png).digest('hex')).toBe(full.envelope.data.image.sha256);
    expect(png.readUInt32BE(16)).toBe(1280);

    const thumb = await call<PreviewArtifact>('snapshot_preview', { projectId, version: id, image: 'thumbnail' });
    const small = thumb.content[1];
    if (small?.type !== 'image') throw new Error('expected image content');
    expect(Buffer.from(small.data, 'base64').readUInt32BE(16)).toBe(400);
    expect(thumb.envelope.data.cached).toBe(true);

    const none = await call<PreviewArtifact>('snapshot_preview', { projectId, version: id, image: 'none' });
    expect(none.content).toHaveLength(1);
    expect(none.envelope.data.artifactId).toBeTruthy();

    // A picture of a PNG in the version; a file that can't be previewed is
    // the usual refusal with no picture.
    const hero = await call<PreviewArtifact>('snapshot_preview', { projectId, version: id, file: 'hero.png' });
    expect(hero.envelope.data.subject).toMatchObject({ kind: 'image', path: 'hero.png' });
    expect(hero.content[1]?.type).toBe('image');
    const css = await call('snapshot_preview', { projectId, version: id, file: 'site.css' });
    expect(css.isError).toBe(true);
    expect(css.envelope.error).toMatchObject({ code: 'PREVIEW_UNSUPPORTED', details: { reason: 'file-type' } });
    expect(css.content).toHaveLength(1);
    // An unknown choice is refused by the host's validation, before the Engine.
    const huge = (await client.callTool({
      name: 'snapshot_preview',
      arguments: { projectId, version: id, image: 'huge' },
    })) as { isError?: boolean; content: Content[] };
    expect(huge.isError).toBe(true);
    expect(huge.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/image/) as string });
  });

  it('follows the switch while connected', async () => {
    await desktop.call('agentAccess.set', { enabled: false });
    const denied = await call('project_list');
    expect(denied.isError).toBe(true);
    expect(denied.envelope.error?.code).toBe('AGENT_ACCESS_DISABLED');
    const info = await call<{ agentAccess: { enabled: boolean }; channel: string }>('engine_info');
    expect(info.envelope.data).toMatchObject({ agentAccess: { enabled: false }, channel: 'mcp' });
    await desktop.call('agentAccess.set', { enabled: true });
    expect((await call('project_list')).envelope.ok).toBe(true);
  });
});
