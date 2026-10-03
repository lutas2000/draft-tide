// 設定與診斷 on a real Engine (M1 plan §4.1): storage use by part, and the
// diagnostics report, which must carry no folder, name, id, account or token
// the Engine knows, even where its log quotes them.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_STORE_PARTS, DiagnosticsReport, DtError } from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir, write } from '../../../packages/git-backend/test/helpers.ts';
import { cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

const dataDir = tempDataDir();
let desktop: EngineConnection;
let root: string;
let projectId: string;
const NAME = 'Secret Client Site';
const REQUESTED = '/Users/zed/Private Stuff/next';

beforeAll(async () => {
  desktop = await connectTo(dataDir, 'desktop', 5_000);
  root = join(realpathSync(tempDir()), 'Secret Client');
  mkdirSync(root);
  write(root, 'index.html', '<h1>hi</h1>\n');
  // Random bytes don't compress, so the history holds at least this much on
  // every platform (Windows Git counts bytes, not disk blocks, in whole KiB).
  write(root, 'logo.png', randomBytes(64 * 1024));
  const review = await desktop.call('project.review', { root });
  const bound = await desktop.call('project.bind', {
    root,
    name: NAME,
    entryFiles: [],
    reviewToken: review.reviewToken,
  });
  projectId = bound.project.projectId;
  write(root, 'index.html', '<h1>hi again</h1>\n');
  await desktop.call('snapshot.create', { projectId, name: 'Second' });
  // An agent asked for another folder (the request records its path).
  await desktop.call('agentAccess.set', { enabled: true });
  const tool = await connectTo(dataDir, 'cli');
  await tool.call('project.connectRequest', { root: REQUESTED }).catch((e: unknown) => {
    if (!(e instanceof DtError) || e.code !== 'CONFIRMATION_REQUIRED') throw e;
  });
  tool.close();
});

afterAll(async () => {
  desktop?.close();
  await cleanupDataDirs();
  cleanupTempDirs();
});

describe('設定與診斷', () => {
  it('measures the data directory by part, and each project history', async () => {
    const usage = await desktop.call('diagnostics.usage', {});
    const { parts } = usage.dataStore;
    expect(parts.database).toBeGreaterThan(0);
    expect(parts.logs).toBeGreaterThan(0);
    expect(usage.dataStore.total).toBe(DATA_STORE_PARTS.reduce((sum, p) => sum + parts[p], 0));
    expect(usage.dataStore.complete).toBe(true);
    expect(usage.dataStore.availableBytes).toBeGreaterThan(0);
    expect(usage.projects).toEqual([
      expect.objectContaining({ projectId, name: NAME, sameVolumeAsDataStore: expect.any(Boolean) as boolean }),
    ]);
    expect(usage.projects[0]?.historyBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(usage.projects[0]?.availableBytes).toBeGreaterThan(0);
  });

  it('reports states, codes and sizes under labels, and de-identifies the log', async () => {
    // What the Engine's log might quote: the folder, the project's id, a
    // token, an address, the requested folder.
    appendFileSync(
      join(dataDir, 'diagnostics', 'engine.log'),
      [
        `test line: cannot read ${root}/index.html for ${projectId}`,
        `test line: recovery for project ${projectId.slice(0, 8)}`,
        `test line: ${NAME} as someone@example.com with ghr_0123456789abcdefghijklmnop`,
        `test line: request for ${REQUESTED} in ${dataDir}`,
        '',
      ].join('\n'),
    );
    const report = await desktop.call('diagnostics.report', {});
    expect(DiagnosticsReport.safeParse(report).success).toBe(true);
    const text = JSON.stringify(report);
    for (const secret of [root, NAME, projectId, projectId.slice(0, 8), REQUESTED, dataDir, 'someone@example.com']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toMatch(/gh[opsur]_/);

    expect(report.projects).toEqual([
      expect.objectContaining({
        label: 'project-1',
        folder: 'available',
        checkError: null,
        recoveryRequired: false,
        hasVersions: true,
        sync: null,
      }),
    ]);
    expect(report.projects[0]?.historyBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(report.agentAccess.enabled).toBe(true);
    expect(report.app.runtime.git).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.operations.readError).toBeNull();
    expect(report.operations.open).toEqual([
      expect.objectContaining({ kind: 'connect-request', state: 'awaiting-user', origin: 'cli', project: null }),
    ]);
    expect(report.operations.ended).toContainEqual({ kind: 'save', state: 'completed', error: null, count: 1 });

    const log = report.log.text;
    expect(log).toContain('test line: cannot read <project-1 folder>/index.html for project-1');
    expect(log).toContain('test line: recovery for project project-1');
    expect(log).toContain('<project-1 name> as <email> with <token>');
    expect(log).toContain('request for <requested folder> in <private path>');
  });

  it('is for the app only', async () => {
    const tool = await connectTo(dataDir, 'mcp');
    for (const op of ['diagnostics.usage', 'diagnostics.report']) {
      await expect(tool.callRaw(op, {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    }
    tool.close();
  });
});
