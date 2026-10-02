// What the tool channel may only ask for (M1 plan §9.1, §13.2): connecting a
// folder. The agent's request waits for the user in the app; the agent follows
// it with operation status and sees it completed, declined or withdrawn. Also
// the CLI's restore and operation commands on a real Engine.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DtError, EXIT_CODES, type EngineEvent } from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  committedRepo,
  gitStatus,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

const dataDir = tempDataDir();
let desktop: EngineConnection;
const events: EngineEvent[] = [];

beforeAll(async () => {
  desktop = await connectTo(dataDir, 'desktop', 5_000);
  desktop.onEvent((e) => events.push(e));
});

afterAll(async () => {
  desktop?.close();
  await cleanupDataDirs();
  cleanupTempDirs();
});

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; details: Record<string, unknown> } | null;
}

function cliJson(...args: string[]): { status: number | null; envelope: Envelope } {
  const r = cli('--json', ...args);
  return { status: r.status, envelope: JSON.parse(r.stdout) as Envelope };
}

async function refusal(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

// Asks for a folder through the CLI and returns the request's id.
function request(root: string, ...extra: string[]): string {
  const { status, envelope } = cliJson('init', 'request', '--root', root, ...extra);
  expect(status).toBe(EXIT_CODES.failed);
  expect(envelope.error?.code).toBe('CONFIRMATION_REQUIRED');
  const id = envelope.error?.details['operationId'];
  expect(typeof id).toBe('string');
  return id as string;
}

describe('asking the user to connect a folder', () => {
  it('needs agent access, and never reads the folder it names', async () => {
    expect(cliJson('init', 'request', '--root', '/tmp/x').envelope.error?.code).toBe('AGENT_ACCESS_DISABLED');
    await desktop.call('agentAccess.set', { enabled: true });
    // The folder doesn't even exist: the request is only a suggestion.
    const id = request(join(tempDir(), 'not-there'), '--entry', 'index.html', '--name', 'Pricing');
    const { envelope } = cliJson('operation', 'status', id);
    expect(envelope.data).toMatchObject({
      kind: 'connect-request',
      state: 'awaiting-user',
      origin: 'cli',
      projectId: null,
      request: { name: 'Pricing', entryFiles: ['index.html'] },
      project: null,
    });
    const human = cli('init', 'request', '--root', '/tmp/elsewhere');
    expect(human.stderr).toMatch(/CONFIRMATION_REQUIRED/);
    expect(human.stderr).toMatch(/Operation: [0-9a-f-]{36}/);
  });

  it('shows the request in the app, which can decline it', async () => {
    const id = request('/tmp/declined-folder');
    await expect.poll(() => events.some((e) => e.name === 'operations.changed')).toBe(true);
    const list = await desktop.call('operation.list', {});
    expect(list.requests.map((r) => r.operationId)).toContain(id);
    const declined = await desktop.call('request.decline', { operationId: id });
    expect(declined).toMatchObject({ state: 'denied', error: { code: 'APPROVAL_DENIED' } });
    expect(cliJson('operation', 'status', id).envelope.data).toMatchObject({
      state: 'denied',
      error: { code: 'APPROVAL_DENIED' },
    });
    expect((await desktop.call('operation.list', {})).requests.map((r) => r.operationId)).not.toContain(id);
  });

  it('completes when the user connects a folder in answer to it', async () => {
    const root = committedRepo({ 'index.html': '<h1>hi</h1>\n' });
    const id = request(root);
    const review = await desktop.call('project.review', { root });
    const bound = await desktop.call('project.bind', {
      root,
      name: 'Answered',
      entryFiles: [],
      reviewToken: review.reviewToken,
      requestId: id,
    });
    const status = cliJson('operation', 'status', id).envelope.data;
    expect(status).toMatchObject({ state: 'completed', project: { projectId: bound.project.projectId, root } });
    // A request that was answered can't be declined or withdrawn any more.
    expect(cliJson('operation', 'cancel', id).envelope.data).toMatchObject({ outcome: 'ended' });
  });

  it('can be withdrawn by the agent', async () => {
    const id = request('/tmp/withdrawn');
    const { envelope } = cliJson('operation', 'cancel', id);
    expect(envelope.data).toMatchObject({ outcome: 'cancelled', operation: { state: 'cancelled' } });
    expect((await desktop.call('operation.list', {})).requests.map((r) => r.operationId)).not.toContain(id);
  });

  it('is the only way in: no self-asserted flag lets the tool channel connect a folder', async () => {
    const tool = await connectTo(dataDir, 'cli');
    expect((await refusal(tool.callRaw('project.bind', {}))).code).toBe('UNKNOWN_OPERATION');
    expect((await refusal(tool.callRaw('project.review', { root: '/tmp' }))).code).toBe('UNKNOWN_OPERATION');
    expect((await refusal(tool.callRaw('project.connectRequest', { root: '/tmp/x', confirmed: true }))).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect((await refusal(tool.callRaw('project.connectRequest', { root: 'relative/path' }))).details).toMatchObject({
      reason: 'relative-path',
    });
    tool.close();
    const yes = cli('--json', 'init', 'request', '--root', '/tmp/x', '--yes');
    expect(yes.status).toBe(EXIT_CODES.usage);
    // The app can't be asked to ask: it connects folders itself.
    expect((await refusal(desktop.callRaw('project.connectRequest', { root: '/tmp/x' }))).code).toBe(
      'UNKNOWN_OPERATION',
    );
  });

  it('keeps a bounded number of requests waiting', async () => {
    const waiting = (await desktop.call('operation.list', {})).requests.length;
    for (let i = waiting; i < 20; i++) request(`/tmp/many-${i}`);
    const { envelope } = cliJson('init', 'request', '--root', '/tmp/one-too-many');
    expect(envelope.error).toMatchObject({ code: 'RESOURCE_BUDGET_EXCEEDED', details: { budget: 'pending-requests' } });
    for (const r of (await desktop.call('operation.list', {})).requests) {
      await desktop.call('request.decline', { operationId: r.operationId });
    }
  });

  it('answers unknown operation ids with a stable error', () => {
    const { status, envelope } = cliJson('operation', 'status', '00000000-0000-4000-8000-000000000000');
    expect(status).toBe(EXIT_CODES.usage);
    expect(envelope.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { reason: 'unknown-operation' } });
  });
});

describe('restoring through the CLI', () => {
  it('plans and applies a restore, and the app hears about it', async () => {
    const root = committedRepo({ 'index.html': 'v1\n' });
    const review = await desktop.call('project.review', { root });
    const { project } = await desktop.call('project.bind', {
      root,
      name: 'CLI restore',
      entryFiles: [],
      reviewToken: review.reviewToken,
    });
    const projectId = project.projectId;
    const v1 = await desktop.call('snapshot.create', { projectId });
    write(root, 'index.html', 'v2\n');
    await desktop.call('snapshot.create', { projectId });
    write(root, 'index.html', 'unsaved\n');

    const human = cli('--project', projectId, 'restore', 'plan', v1.snapshotId);
    expect(human.stdout).toMatch(/Restore to V1/);
    expect(human.stdout).toMatch(/1 overwritten, 0 added, 0 deleted/);
    expect(human.stdout).toMatch(/saved as a pre-restore version first/);

    const plan = cliJson('--project', projectId, 'restore', 'plan', v1.snapshotId).envelope;
    expect(plan).toMatchObject({ ok: true, data: { protection: { needed: true }, blocked: null } });
    const applied = cliJson('--project', projectId, 'restore', 'apply', String(plan.data?.['planId']));
    expect(applied.status).toBe(EXIT_CODES.ok);
    expect(applied.envelope.data).toMatchObject({
      written: 1,
      deleted: 0,
    });
    expect(applied.envelope.data?.['protection']).not.toBeNull();
    expect(gitStatus(root)).toBe('');

    // Applying the same plan twice is refused; the app got a notice.
    const again = cliJson('--project', projectId, 'restore', 'apply', String(plan.data?.['planId']));
    expect(again.envelope.error).toMatchObject({ code: 'PLAN_STALE', details: { reason: 'used' } });
    const notices = (await desktop.call('operation.list', {})).notices;
    expect(notices[0]).toMatchObject({ kind: 'restore', origin: 'cli', state: 'completed' });
    await expect
      .poll(() =>
        events.some((e) => e.name === 'project.changed' && e.projectId === projectId && e.reason === 'restored'),
      )
      .toBe(true);
    const op = cliJson('operation', 'status', String(applied.envelope.data?.['operationId'])).envelope.data;
    expect(op).toMatchObject({ kind: 'restore', state: 'completed', origin: 'cli' });

    // Nothing left to recover.
    expect(cli('--project', projectId, 'recover', 'inspect').stdout).toMatch(/Nothing to recover/);
    expect(cliJson('--project', projectId, 'recover', 'plan', '--strategy', 'finish').status).toBe(EXIT_CODES.usage);
  });
});
