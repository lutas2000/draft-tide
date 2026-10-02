// Remote sync through real Engine processes and the CLI (M1-07): two
// computers (two data stores, two Engines) and a fake GitHub on loopback that
// both Engines reach through DRAFT_TIDE_TEST_GITHUB. Sign-in and connecting a
// repository happen on the desktop channel, as in the app; everything an
// agent may do goes through the CLI. The fake lives in this process, so the
// CLI is spawned asynchronously.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../fixtures/fake-github.ts';
import {
  cleanupTempDirs,
  committedRepo,
  gitStatus,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

let gh: FakeGitHub;
const connections: EngineConnection[] = [];

beforeAll(async () => {
  gh = await startFakeGitHub({ rootDir: tempDir('dt-fakegh-') });
});

afterAll(async () => {
  for (const c of connections.splice(0)) c.close();
  await cleanupDataDirs();
  await gh.close();
  cleanupTempDirs();
});

interface Envelope {
  ok: boolean;
  data: Record<string, unknown> & { planId?: string };
  error: { code: string; details: Record<string, unknown> } | null;
}

function cli(dataDir: string, ...args: string[]): Promise<{ status: number; envelope: Envelope; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_SOURCE, '--json', '--data-dir', dataDir, ...args], {
      env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000', DRAFT_TIDE_TEST_GITHUB: gh.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ status: code ?? -1, envelope: JSON.parse(stdout) as Envelope, stdout });
      } catch (e) {
        reject(new Error(`not one envelope: ${stdout}`, { cause: e }));
      }
    });
  });
}

async function computer(): Promise<{ dataDir: string; desktop: EngineConnection }> {
  const dataDir = tempDataDir();
  const desktop = await connectTo(dataDir, 'desktop', 5_000, { DRAFT_TIDE_TEST_GITHUB: gh.env });
  connections.push(desktop);
  await desktop.call('agentAccess.set', { enabled: true });
  return { dataDir, desktop };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function signIn(desktop: EngineConnection): Promise<void> {
  await desktop.call('auth.loginStart', {});
  await until(
    () => desktop.call('auth.status', {}),
    (s) => s.state === 'signed-in',
    'sign-in',
  );
}

const head = (root: string) => plainGit(root, ['rev-parse', 'HEAD']).trim();

describe('sync through the Engine and the CLI', () => {
  it('signs in in the app, connects there, then syncs two computers through the CLI', async () => {
    gh.createRepo('designer', 'cli-site');
    const a = await computer();

    // The CLI reads who is signed in and may only ask.
    expect((await cli(a.dataDir, 'auth', 'status')).envelope.data).toMatchObject({ state: 'signed-out', login: null });
    const asked = await cli(a.dataDir, 'auth', 'login', 'request');
    expect(asked.status).toBe(1);
    expect(asked.envelope.error?.code).toBe('CONFIRMATION_REQUIRED');
    const requestId = String(asked.envelope.error?.details['operationId']);
    await signIn(a.desktop);
    expect((await cli(a.dataDir, 'operation', 'status', requestId)).envelope.data).toMatchObject({
      kind: 'login-request',
      state: 'completed',
    });

    // The app connects a folder and a repository (the first push).
    const rootA = committedRepo({ 'index.html': 'one\n' });
    const review = await a.desktop.call('project.review', { root: rootA });
    const { project } = await a.desktop.call('project.bind', {
      root: rootA,
      name: 'CLI site',
      entryFiles: [],
      reviewToken: review.reviewToken,
    });
    const projectId = project.projectId;
    await a.desktop.call('snapshot.create', { projectId });
    expect((await cli(a.dataDir, '--project', projectId, 'remote', 'connect', 'request')).envelope.error?.code).toBe(
      'CONFIRMATION_REQUIRED',
    );
    const plan = await a.desktop.call('remote.connectPlan', {
      projectId,
      repo: { owner: 'designer', name: 'cli-site' },
    });
    await a.desktop.call('remote.connectApply', { projectId, planId: plan.planId, setOrigin: true });
    expect((await cli(a.dataDir, '--project', projectId, 'remote', 'status')).envelope.data).toMatchObject({
      state: 'synced',
      remote: { owner: 'designer', name: 'cli-site' },
    });

    // An agent's save is pushed in the background.
    write(rootA, 'index.html', 'two\n');
    expect((await cli(a.dataDir, '--project', projectId, 'snapshot', '--message', 'two')).status).toBe(0);
    await until(
      () => Promise.resolve(gh.branchTip('designer', 'cli-site', 'main')),
      (tip) => tip === head(rootA),
      'the background push',
    );
    expect((await cli(a.dataDir, '--project', projectId, 'sync', 'push')).envelope.data).toMatchObject({
      outcome: 'up-to-date',
    });

    // Another computer opens it through the CLI.
    const b = await computer();
    await signIn(b.desktop);
    const rootB = join(tempDir('dt-cli-open-'), 'site');
    const openPlan = await cli(
      b.dataDir,
      'remote',
      'open',
      'plan',
      '--url',
      'https://github.com/designer/cli-site',
      '--destination',
      rootB,
    );
    expect(openPlan.envelope).toMatchObject({ ok: true, data: { destination: { exists: false }, blocked: null } });
    const opened = await cli(b.dataDir, 'remote', 'open', 'apply', String(openPlan.envelope.data.planId));
    expect(opened.envelope).toMatchObject({ ok: true, data: { project: { projectId, root: rootB } } });
    expect(head(rootB)).toBe(head(rootA));
    expect(gitStatus(rootB)).toBe('');

    // B saves and pushes; A gets it through the CLI.
    write(rootB, 'index.html', 'three from B\n');
    await cli(b.dataDir, '--project', projectId, 'snapshot');
    // The background push may already have sent it: either way GitHub has it.
    expect((await cli(b.dataDir, '--project', projectId, 'sync', 'push')).envelope.ok).toBe(true);
    expect(gh.branchTip('designer', 'cli-site', 'main')).toBe(head(rootB));
    const pull = await cli(a.dataDir, '--project', projectId, 'sync', 'pull', 'plan');
    expect(pull.envelope.data).toMatchObject({ relation: 'behind', incoming: 1, blocked: null });
    const pulled = await cli(
      a.dataDir,
      '--project',
      projectId,
      'sync',
      'pull',
      'apply',
      String(pull.envelope.data.planId),
    );
    expect(pulled.envelope).toMatchObject({ ok: true, data: { written: 1 } });
    expect(readFileSync(join(rootA, 'index.html'), 'utf8')).toBe('three from B\n');
    expect(head(rootA)).toBe(head(rootB));
    expect(gitStatus(rootA)).toBe('');

    // B saves and its version reaches GitHub; then A saves on the old base:
    // A's push is refused and nothing changes anywhere.
    write(rootB, 'index.html', 'four from B\n');
    await cli(b.dataDir, '--project', projectId, 'snapshot');
    await cli(b.dataDir, '--project', projectId, 'sync', 'push');
    const remoteTip = gh.branchTip('designer', 'cli-site', 'main');
    expect(remoteTip).toBe(head(rootB));
    write(rootA, 'index.html', 'four from A\n');
    await cli(a.dataDir, '--project', projectId, 'snapshot');
    const refused = await cli(a.dataDir, '--project', projectId, 'sync', 'push');
    expect(refused.envelope.error).toMatchObject({ code: 'REMOTE_DIVERGED', details: { reason: 'diverged' } });
    expect(gh.branchTip('designer', 'cli-site', 'main')).toBe(remoteTip);
    expect(readFileSync(join(rootA, 'index.html'), 'utf8')).toBe('four from A\n');

    // Token hygiene: not in either data directory (SQLite, logs, tmp), not in
    // either project's .git, not in anything the CLI printed.
    const leaks: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (e.isFile() && gh.tokens.some((t) => readFileSync(p).includes(t))) leaks.push(p);
      }
    };
    for (const d of [a.dataDir, b.dataDir, join(rootA, '.git'), join(rootB, '.git')]) scan(d);
    expect(leaks).toEqual([]);
    for (const out of [asked.stdout, openPlan.stdout, opened.stdout, pull.stdout, pulled.stdout, refused.stdout]) {
      expect(out).not.toMatch(/gh[ur]_/);
    }
    expect(readdirSync(join(a.dataDir, 'tmp')).filter((n) => n.startsWith('net-'))).toEqual([]);
  }, 180_000);
});
