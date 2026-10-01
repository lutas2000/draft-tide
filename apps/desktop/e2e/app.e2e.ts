import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDesktop } from '../scripts/build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
const companionCli = join(root, '..', 'companion', 'dist', 'cli.mjs');
const shots = join(root, 'test-results');

const dataDir = mkdtempSync(join(tmpdir(), 'dt-e2e-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'dt-e2e-ud-'));
let app: ElectronApplication;
let page: Page;

function cliEnvelope(...args: string[]): { ok: boolean; error: { code: string } | null } {
  const r = spawnSync(process.execPath, [companionCli, '--json', '--data-dir', dataDir, ...args], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as { ok: boolean; error: { code: string } | null };
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'dist-e2e', 'main', 'main.mjs'), `--user-data-dir=${userDataDir}`],
    env: {
      ...(process.env as Record<string, string>),
      DRAFT_TIDE_DATA_DIR: dataDir,
      DRAFT_TIDE_ENGINE_IDLE_MS: '1500',
    },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
});

afterAll(async () => {
  await app?.close();
  try {
    const d = JSON.parse(readFileSync(join(dataDir, 'runtime', 'engine.json'), 'utf8')) as { pid: number };
    process.kill(d.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('desktop app', () => {
  it('opens on the projects screen with the Engine connected', async () => {
    await expect.poll(() => page.title()).toBe('Draft Tide');
    await page.getByText('引擎已連線').waitFor();
    await page.getByText('還沒有專案').waitFor();
    // Not-yet-built entry points are visible but marked, never clickable.
    expect(await page.getByText('尚未提供').count()).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: join(shots, 'projects.png') });
  });

  it('gives the renderer no Node and only the bridge', async () => {
    const probe = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        require?: unknown;
        process?: unknown;
        draftTide: { invoke(op: string, payload: unknown): Promise<{ ok: boolean; error: { code: string } | null }> };
      };
      return {
        require: typeof w.require,
        process: typeof w.process,
        bridge: Object.keys(w.draftTide).sort(),
        unknownOp: (await w.draftTide.invoke('shell.exec', { cmd: 'id' })).error?.code,
        badInput: (await w.draftTide.invoke('agentAccess.set', { enabled: true, confirmed: true })).error?.code,
      };
    });
    expect(probe).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['connectionState', 'invoke', 'onConnection', 'onEvent', 'reconnect'],
      unknownOp: 'UNKNOWN_OPERATION',
      badInput: 'INVALID_ARGUMENT',
    });
  });

  it('turns agent access on only after confirmation, and the CLI follows', async () => {
    await page.getByRole('button', { name: '設定與診斷' }).click();
    const toggle = page.getByRole('switch', { name: '允許 agent 存取' });
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false');
    await expect.poll(() => toggle.isEnabled()).toBe(true);
    expect(cliEnvelope('project', 'list').error?.code).toBe('AGENT_ACCESS_DISABLED');

    await toggle.click();
    await page.getByRole('alertdialog').waitFor();
    await page.screenshot({ path: join(shots, 'agent-access-confirm.png') });
    await page.getByRole('button', { name: '取消' }).click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false');
    expect(cliEnvelope('project', 'list').ok).toBe(false);

    await toggle.click();
    await page.getByRole('button', { name: '開啟 agent 存取' }).click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
    expect(cliEnvelope('project', 'list')).toMatchObject({ ok: true });
    await page.getByText('開發版本：未驗證簽章').waitFor();
    await page.screenshot({ path: join(shots, 'settings.png') });

    await toggle.click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false');
    expect(cliEnvelope('project', 'list').error?.code).toBe('AGENT_ACCESS_DISABLED');
  });

  it('shows the account screen without pretending sync exists', async () => {
    await page.getByRole('button', { name: '帳號與同步' }).click();
    await page.getByText('沒有異地備份', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'account.png') });
  });
});

describe('debugging-switch guard', () => {
  beforeAll(async () => {
    await buildDesktop({ mode: 'development', skipGui: true });
  });

  it.each(['--remote-debugging-port=0', '--remote-debugging-pipe', '--js-flags=--allow-natives-syntax'])(
    'refuses to start a user build with %s',
    async (flag) => {
      const child = spawn(electronPath, [join(root, 'dist', 'main', 'main.mjs'), flag], {
        env: { ...process.env, DRAFT_TIDE_DATA_DIR: dataDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 15_000);
        child.once('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(1);
      expect(stderr).toContain('refusing to start');
    },
  );
});
