import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiagnosticsReport } from '@draft-tide/contracts';
import { makePng } from '../../companion/test/png.ts';
import { buildDesktop } from '../scripts/build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
const companionCli = join(root, '..', 'companion', 'dist', 'cli.mjs');
const shots = join(root, 'test-results');

const dataDir = mkdtempSync(join(tmpdir(), 'dt-e2e-'));
let app: ElectronApplication;
let page: Page;

interface CliEnvelope {
  ok: boolean;
  data: unknown;
  error: { code: string; details: Record<string, unknown> } | null;
}

function cliEnvelope(...args: string[]): CliEnvelope {
  const r = spawnSync(process.execPath, [companionCli, '--json', '--data-dir', dataDir, ...args], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as CliEnvelope;
}

// A design folder as an agent might leave it, and the user's own Git without
// Draft Tide's hardening (it never reads the developer's config).
const designDir = realpathSync(mkdtempSync(join(tmpdir(), 'dt-e2e-design-')));
const gitConfig = join(mkdtempSync(join(tmpdir(), 'dt-e2e-git-')), 'gitconfig');
// No background maintenance: its lock files would race with the checks.
writeFileSync(
  gitConfig,
  '[user]\n\tname = Engineer\n\temail = eng@example.com\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n',
);
function plainGit(...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  return execFileSync('git', args, { cwd: designDir, env, encoding: 'utf8' });
}
const nav = (name: string) => page.getByRole('navigation', { name: '主要' }).getByRole('button', { name });

function write(rel: string, content: string | Buffer): void {
  mkdirSync(join(designDir, rel, '..'), { recursive: true });
  writeFileSync(join(designDir, rel), content);
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  app = await electron.launch({
    executablePath: electronPath,
    // No --user-data-dir: the app keeps its Chromium profile in the data
    // directory's desktop/ folder (checked below).
    args: [join(root, 'dist-e2e', 'main', 'main.mjs')],
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
  rmSync(designDir, { recursive: true, force: true });
});

describe('desktop app', () => {
  it('opens on the projects screen with the Engine connected', async () => {
    await expect.poll(() => page.title()).toBe('Draft Tide');
    await page.getByText('引擎已連線').waitFor();
    await page.getByText('還沒有專案').waitFor();
    // Not-yet-built entry points are visible but marked, never clickable.
    expect(await page.getByText('尚未提供').count()).toBe(1);
    expect(await page.getByRole('button', { name: /從 GitHub 開啟/ }).isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: /開啟設計資料夾/ }).isEnabled()).toBe(true);
    await page.screenshot({ path: join(shots, 'projects.png') });
    // Chromium's profile is in its own subfolder of the data directory,
    // never beside the Engine's state.
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(
      join(dataDir, 'desktop'),
    );
    await expect.poll(() => readdirSync(join(dataDir, 'desktop')).length).toBeGreaterThan(0);
    const engineFiles = new Set(['desktop', 'diagnostics', 'git-home', 'projects', 'runtime', 'tmp']);
    expect(readdirSync(dataDir).filter((f) => !engineFiles.has(f) && !f.startsWith('state.sqlite'))).toEqual([]);
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
      bridge: [
        'agentSetup',
        'chooseFolder',
        'connectionState',
        'copyText',
        'exportDiagnostics',
        'invoke',
        'onConnection',
        'onEvent',
        'openExternal',
        'reconnect',
        'revealDiagnostics',
      ],
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

  it('refuses to review a folder that was not chosen in the native picker', async () => {
    const code = await page.evaluate(async (root) => {
      const w = globalThis as unknown as {
        draftTide: {
          invoke(op: string, payload: unknown): Promise<{ error: { details: { reason?: string } } | null }>;
        };
      };
      return (await w.draftTide.invoke('project.review', { root })).error?.details.reason;
    }, designDir);
    expect(code).toBe('folder-not-chosen');
  });

  it('offers GitHub sign-in on the account screen, as a skippable option', async () => {
    await page.getByRole('button', { name: '帳號與同步' }).click();
    await page.getByText('登入 GitHub 是可略過的選項', { exact: false }).waitFor();
    // Not signed in: this run never starts a sign-in (it would reach github.com).
    await page.getByRole('button', { name: '登入 GitHub' }).waitFor();
    await page.screenshot({ path: join(shots, 'account.png') });
  });
});

describe('the first manual flow (M1-04)', () => {
  let projectId = '';

  beforeAll(async () => {
    write('index.html', '<!doctype html>\n<link rel=stylesheet href=css/site.css>\n<h1>Pricing</h1>\n');
    write('css/site.css', 'body { margin: 0; }\n');
    write('img/hero.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    write('.env', 'API_KEY=secret\n');
    write('node_modules/lib/index.js', 'module.exports = 1;\n');
    // The native picker, answered as a user would.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
    }, designDir);
    await nav('專案').click();
  });

  it('reviews the folder before writing anything', async () => {
    await page.getByRole('button', { name: /開啟設計資料夾/ }).click();
    await page.getByRole('heading', { name: '確認保存範圍' }).waitFor();
    await page.getByText('3 個檔案', { exact: false }).first().waitFor();
    await page.getByText('.env', { exact: true }).waitFor();
    await page.getByText('會在資料夾裡建立', { exact: false }).waitFor();
    // Reviewing wrote nothing: no .git, no settings file.
    expect(spawnSync('ls', ['-A', designDir], { encoding: 'utf8' }).stdout.split('\n').sort()).toEqual(
      ['', '.env', 'css', 'img', 'index.html', 'node_modules'].sort(),
    );
    await page.getByLabel('專案名稱').fill('Pricing page');
    await page.screenshot({ path: join(shots, 'review.png') });
  });

  it('connects the folder and saves the first version', async () => {
    await page.getByRole('button', { name: /確認並保存第一版/ }).click();
    await page.getByRole('heading', { name: '版本歷史' }).waitFor();
    await page.getByText('沒有新的變更').waitFor();
    await page.getByRole('listitem').filter({ hasText: '第一版' }).waitFor();
    const list = cliEnvelope('project', 'list');
    // Agent access is off: the CLI can't see projects yet.
    expect(list.error?.code).toBe('AGENT_ACCESS_DISABLED');
    const projects = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        draftTide: { invoke(op: string, payload: unknown): Promise<{ data: { projectId: string; name: string }[] }> };
      };
      return (await w.draftTide.invoke('project.list', {})).data;
    });
    expect(projects.map((p) => p.name)).toEqual(['Pricing page']);
    projectId = projects[0]?.projectId ?? '';
    // The user's own Git sees a clean folder; the defaults kept secrets out.
    expect(plainGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(plainGit('ls-files').split('\n').filter(Boolean).sort()).toEqual(
      ['.drafttide.json', 'css/site.css', 'img/hero.png', 'index.html'].sort(),
    );
    await page.screenshot({ path: join(shots, 'project-first-version.png') });
  });

  it('notices an edit and saves it as a named version', async () => {
    write(
      'index.html',
      '<!doctype html>\n<link rel=stylesheet href=css/site.css>\n<h1>Pricing</h1>\n<p>Yearly plans</p>\n',
    );
    await page.getByRole('button', { name: '重新檢查' }).click();
    await page.getByText('有 1 個檔案尚未保存').waitFor();
    await page.screenshot({ path: join(shots, 'project-unsaved.png') });
    await page.getByRole('button', { name: '保存版本' }).click();
    await page.getByLabel('版本名稱', { exact: false }).fill('Yearly plans');
    await page.getByRole('dialog').getByRole('button', { name: '保存版本' }).click();
    await page.getByText('已保存「Yearly plans」').waitFor();
    await page.getByRole('listitem').filter({ hasText: 'Yearly plans' }).waitFor();
    expect(await page.getByRole('listitem').count()).toBe(2);
  });

  it('does not add a version when nothing changed', async () => {
    await page.getByRole('button', { name: '保存版本' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '保存版本' }).click();
    await page.getByText('不會建立重複的版本', { exact: false }).waitFor();
    expect(await page.getByRole('listitem').count()).toBe(2);
    expect(plainGit('rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it("shows another tool's commit as an external change", async () => {
    write('NOTES.md', '# Handoff notes\n');
    plainGit('add', 'NOTES.md');
    plainGit('commit', '--quiet', '-m', 'Add handoff notes');
    await page.getByRole('button', { name: '重新檢查' }).click();
    const external = page.getByRole('listitem').filter({ hasText: 'Add handoff notes' });
    await external.waitFor();
    await external.getByText('外部變更').waitFor();
    await external.click();
    await page.getByText('由其他工具加入', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'project-history.png') });
  });

  it('compares two versions down to the changed lines', async () => {
    await page.getByRole('listitem').filter({ hasText: 'Yearly plans' }).click();
    await page.getByRole('button', { name: '與上一筆比較' }).click();
    await page.getByRole('heading', { name: '比較版本' }).waitFor();
    await page.getByText('修改 1').waitFor();
    // The first changed text file opens by itself; lines are text, not HTML.
    await page.getByText('<p>Yearly plans</p>').waitFor();
    await page.getByText('+1 行').waitFor();
    await page.screenshot({ path: join(shots, 'compare.png') });
  });

  it('shows where the CLI, MCP server and Skill are, ready to paste', async () => {
    await nav('設定與診斷').click();
    const card = page.getByRole('region', { name: 'CLI / MCP / Skill 設定' });
    await card.getByText('命令列工具').waitFor();
    // The CLI line names this build's companion and this window's data
    // directory, so an agent reaches the same Engine.
    const cliLine = await card.locator('pre').first().innerText();
    expect(cliLine).toContain(companionCli);
    expect(cliLine).toContain('--data-dir');
    await card.getByRole('button', { name: '複製 MCP 設定' }).click();
    await card.getByText('已複製').waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    const config = JSON.parse(copied) as { mcpServers: { 'draft-tide': { command: string; args: string[] } } };
    expect(config.mcpServers['draft-tide'].command).toBe(process.execPath);
    expect(config.mcpServers['draft-tide'].args).toEqual([
      '--disable-sigusr1',
      companionCli,
      '--data-dir',
      dataDir,
      'mcp',
      'serve',
    ]);
    const skill = await card.locator('pre').nth(2).innerText();
    expect(existsSync(join(skill, 'SKILL.md'))).toBe(true);
    await page.screenshot({ path: join(shots, 'settings-agent-setup.png') });
  });

  it('gives the CLI the same project, history and diff once agent access is on', async () => {
    await nav('設定與診斷').click();
    await page.getByRole('switch', { name: '允許 agent 存取' }).click();
    await page.getByRole('button', { name: '開啟 agent 存取' }).click();
    await expect
      .poll(() => page.getByRole('switch', { name: '允許 agent 存取' }).getAttribute('aria-checked'))
      .toBe('true');
    const status = cliEnvelope('--project', projectId, 'status');
    expect(status).toMatchObject({ ok: true, data: { folder: 'available', changes: { total: 0 } } });
    const history = cliEnvelope('--project', projectId, 'history') as {
      data: { entries: { source: string; seq: number | null; snapshot: { snapshotId: string } | null }[] };
    };
    expect(history.data.entries.map((e) => [e.source, e.seq])).toEqual([
      ['external', null],
      ['draft-tide', 2],
      ['draft-tide', 1],
    ]);
    const [, v2, v1] = history.data.entries;
    const diff = cliEnvelope(
      '--project',
      projectId,
      'diff',
      v1?.snapshot?.snapshotId ?? '',
      v2?.snapshot?.snapshotId ?? '',
    );
    expect(diff).toMatchObject({ ok: true, data: { summary: { modified: 1, total: 1 } } });
    // A save from the CLI is an agent-requested version, and the GUI sees it.
    write('css/site.css', 'body { margin: 0; color: #123; }\n');
    const saved = cliEnvelope('--project', projectId, 'snapshot', '--message', 'Darker text');
    expect(saved).toMatchObject({ ok: true, data: { kind: 'agent-requested', origin: 'cli' } });
    await nav('專案').click();
    await page.getByRole('button', { name: /Pricing page/ }).click();
    await page.getByRole('listitem').filter({ hasText: 'Darker text' }).getByText('由 agent 請求').waitFor();
    await nav('設定與診斷').click();
    await page.getByRole('switch', { name: '允許 agent 存取' }).click();
    await expect
      .poll(() => page.getByRole('switch', { name: '允許 agent 存取' }).getAttribute('aria-checked'))
      .toBe('false');
  });
});

describe('restore, recovery and agent requests (M1-05)', () => {
  const requested = realpathSync(mkdtempSync(join(tmpdir(), 'dt-e2e-requested-')));
  const read = (rel: string) => readFileSync(join(designDir, rel), 'utf8');
  const tracked = () => plainGit('status', '--porcelain', '--untracked-files=no');
  let projectId = '';

  afterAll(() => rmSync(requested, { recursive: true, force: true }));

  async function openProject(): Promise<void> {
    await nav('專案').click();
    await page.getByRole('button', { name: /Pricing page/ }).click();
    await page.getByRole('heading', { name: '版本歷史' }).waitFor();
  }

  async function setAgentAccess(on: boolean): Promise<void> {
    await nav('設定與診斷').click();
    const toggle = page.getByRole('switch', { name: '允許 agent 存取' });
    await expect.poll(() => toggle.isEnabled()).toBe(true);
    if ((await toggle.getAttribute('aria-checked')) === String(on)) return;
    await toggle.click();
    if (on) await page.getByRole('button', { name: '開啟 agent 存取' }).click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(on));
  }

  it('restores a version after showing what changes, keeping unsaved work as a protection version', async () => {
    await openProject();
    const v1Index = plainGit('show', 'HEAD~3:index.html');
    write('index.html', '<h1>unsaved idea</h1>\n');
    await page.getByRole('button', { name: '重新檢查' }).click();
    await page.getByText('有 1 個檔案尚未保存').waitFor();
    await page.getByRole('listitem').filter({ hasText: '第一版' }).click();
    await page.getByRole('button', { name: '回復到此版' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('回復到 V1').waitFor();
    await dialog.getByText('目前有 1 個未保存的變更', { exact: false }).waitFor();
    await dialog.getByText('請先停止會寫入這個資料夾的工具', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'restore-plan.png') });
    const before = Number(plainGit('rev-list', '--count', 'HEAD').trim());

    await dialog.getByRole('button', { name: '確認回復' }).click();
    await page.getByText('已回復到 V1。回復前的內容保存在 V4（回復前保護）。').waitFor();
    // The bytes of V1, history only added to, and plain Git agrees.
    expect(read('index.html')).toBe(v1Index);
    expect(existsSync(join(designDir, 'NOTES.md'))).toBe(false);
    expect(Number(plainGit('rev-list', '--count', 'HEAD').trim())).toBe(before + 2);
    expect(plainGit('show', 'HEAD~1:index.html')).toBe('<h1>unsaved idea</h1>\n');
    expect(tracked()).toBe('');
    await page.getByRole('listitem').filter({ hasText: '回復版本' }).first().waitFor();
    await page.getByRole('button', { name: '查看回復前保護版本' }).click();
    await page.getByLabel('版本詳細內容').getByText('回復前保護').first().waitFor();
    await page.screenshot({ path: join(shots, 'restore-done.png') });
  });

  it('asks to check again when the files changed after the plan, changing nothing', async () => {
    await page.getByRole('listitem').filter({ hasText: 'Yearly plans' }).click();
    await page.getByRole('button', { name: '回復到此版' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('回復到 V2').waitFor();
    const confirm = dialog.getByRole('button', { name: '確認回復' });
    await expect.poll(() => confirm.isEnabled()).toBe(true);
    const css = read('css/site.css');
    write('css/site.css', 'body { margin: 1px; }\n');
    const head = plainGit('rev-parse', 'HEAD');
    await confirm.click();
    await dialog.getByText('檔案已改變，請重新檢查回復內容').waitFor();
    expect(plainGit('rev-parse', 'HEAD')).toBe(head);
    expect(read('css/site.css')).toBe('body { margin: 1px; }\n');
    await page.screenshot({ path: join(shots, 'restore-stale.png') });
    await dialog.getByRole('button', { name: '重新檢查' }).click();
    await expect.poll(() => confirm.isEnabled()).toBe(true);
    await dialog.getByRole('button', { name: '取消' }).click();
    write('css/site.css', css);
  });

  it('shows an agent’s request to connect a folder; the user declines one and answers another', async () => {
    await setAgentAccess(true);
    writeFileSync(join(requested, 'index.html'), '<h1>requested</h1>\n');
    // The window comes forward with the request.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    const first = cliEnvelope('init', 'request', '--root', requested, '--name', 'Requested');
    expect(first.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(first.error?.details['app']).toBe('shown');
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false))
      .toBe(true);
    const firstId = String(first.error?.details['operationId']);
    await nav('專案').click();
    const banner = page.getByRole('status').filter({ hasText: `Agent 請求連接資料夾：${requested}` });
    await banner.waitFor();
    await page.screenshot({ path: join(shots, 'agent-request.png') });
    await banner.getByRole('button', { name: '拒絕' }).click();
    await banner.waitFor({ state: 'detached' });
    expect(cliEnvelope('operation', 'status', firstId)).toMatchObject({
      ok: true,
      data: { state: 'denied', error: { code: 'APPROVAL_DENIED' } },
    });

    const second = cliEnvelope('init', 'request', '--root', requested, '--name', 'Requested');
    const secondId = String(second.error?.details['operationId']);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
    }, requested);
    await banner.getByRole('button', { name: '選擇資料夾…' }).click();
    await page.getByRole('heading', { name: '確認保存範圍' }).waitFor();
    await page.getByText('請求連接資料夾', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: /確認並保存第一版/ }).click();
    await page.getByRole('heading', { name: '版本歷史' }).waitFor();
    const answered = cliEnvelope('operation', 'status', secondId) as {
      data: { state: string; project: { root: string } };
    };
    expect(answered.data).toMatchObject({ state: 'completed', project: { root: requested } });
  });

  it('tells the user about an agent’s restore and its protection version until dismissed', async () => {
    const list = cliEnvelope('project', 'list') as { data: { projectId: string; name: string }[] };
    projectId = list.data.find((p) => p.name === 'Pricing page')?.projectId ?? '';
    write('index.html', '<h1>agent made this</h1>\n');
    const history = cliEnvelope('--project', projectId, 'history') as {
      data: { entries: { snapshot: { snapshotId: string; name: string | null } | null }[] };
    };
    const yearly = history.data.entries.find((e) => e.snapshot?.name === 'Yearly plans')?.snapshot?.snapshotId ?? '';
    const plan = cliEnvelope('--project', projectId, 'restore', 'plan', yearly) as { data: { planId: string } };
    expect(cliEnvelope('--project', projectId, 'restore', 'apply', plan.data.planId)).toMatchObject({ ok: true });
    const notice = page.getByRole('status').filter({ hasText: 'Agent 經 CLI 把「Pricing page」回復到 V2' });
    await notice.waitFor();
    await notice.getByText('回復前的內容保存在 V6', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'agent-restore-notice.png') });
    await notice.getByRole('button', { name: '知道了' }).click();
    await notice.waitFor({ state: 'detached' });
    expect(tracked()).toBe('');
    await setAgentAccess(false);
  });

  it('finishes an index switch Draft Tide left unfinished from the recovery card', async () => {
    const meta = /Draft-Tide-Snapshot: (.*)$/m.exec(plainGit('log', '-1', '--format=%B'))?.[1] ?? '{}';
    const { operationId } = JSON.parse(meta) as { operationId: string };
    writeFileSync(join(designDir, '.git', 'index.lock'), `draft-tide ${operationId}\n`);
    await openProject();
    await page.getByRole('button', { name: '重新檢查' }).click();
    await page.getByRole('heading', { name: '需要恢復' }).waitFor();
    await page.getByText('請勿手動刪除 .git/index.lock', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'recovery-card.png') });
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '完成', exact: true }).click();
    await expect.poll(() => existsSync(join(designDir, '.git', 'index.lock'))).toBe(false);
    await page.getByRole('heading', { name: '需要恢復' }).waitFor({ state: 'detached' });
    expect(tracked()).toBe('');
  });
});

describe('previews (M1-06)', () => {
  interface Artifact {
    artifactId: string;
    image: { sha256: string; width: number; height: number };
    incomplete: boolean;
    missing: { count: number; entries: { path: string; reason: string }[] };
    blocked: { count: number; entries: { kind: string; target: string }[] };
  }
  type Envelope<T> = { ok: boolean; data: T; error: { code: string; details: Record<string, unknown> } | null };
  let projectId = '';

  // Calls the Engine through the app's own bridge (the trusted GUI frame).
  function invoke<T>(op: string, payload: unknown): Promise<Envelope<T>> {
    return page.evaluate(
      async ([o, p]) => {
        const w = globalThis as unknown as {
          draftTide: { invoke(op: string, payload: unknown): Promise<unknown> };
        };
        return w.draftTide.invoke(o, p);
      },
      [op, payload] as const,
    ) as Promise<Envelope<T>>;
  }

  async function openProject(): Promise<void> {
    await nav('專案').click();
    await page.getByRole('button', { name: /Pricing page/ }).click();
    await page.getByRole('heading', { name: '版本歷史' }).waitFor();
  }

  async function saveVersion(name: string): Promise<string> {
    const saved = await invoke<{ snapshotId: string }>('snapshot.create', { projectId, name });
    expect(saved.ok).toBe(true);
    return saved.data.snapshotId;
  }

  function setEntry(entry: string): void {
    const file = join(designDir, '.drafttide.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { entryFiles: string[] };
    config.entryFiles = [entry];
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }

  beforeAll(async () => {
    await openProject();
    const list = await invoke<{ projectId: string; name: string }[]>('project.list', {});
    projectId = list.data.find((p) => p.name === 'Pricing page')?.projectId ?? '';
  });

  it("shows each version's picture in the history and in its details", async () => {
    await expect
      .poll(() => page.getByRole('img', { name: /的畫面縮圖$/ }).count(), { timeout: 30_000 })
      .toBeGreaterThan(3);
    await page.getByRole('listitem').filter({ hasText: '第一版' }).click();
    const panel = page.getByLabel('版本詳細內容');
    await panel.getByRole('img', { name: 'V1 的畫面預覽' }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(shots, 'project-previews.png') });
    await panel.getByRole('button', { name: '放大 V1 的畫面' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('頁面需要的檔案都在版本裡', { exact: false }).waitFor();
    await dialog.getByText('預覽的產生方式').click();
    await dialog.getByText('Chromium', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'preview-dialog.png') });
    await dialog.getByRole('button', { name: '關閉' }).click();
  });

  it("compares two versions' pictures side by side, and says when they are the same", async () => {
    await page.getByRole('listitem').filter({ hasText: 'Yearly plans' }).click();
    await page.getByRole('button', { name: '與上一筆比較' }).click();
    await page.getByRole('heading', { name: '比較版本' }).waitFor();
    await page.getByRole('img', { name: 'V1 的畫面預覽' }).waitFor({ timeout: 30_000 });
    await page.getByRole('img', { name: 'V2 的畫面預覽' }).waitFor({ timeout: 30_000 });
    expect(await page.getByText('兩個版本的畫面完全相同').count()).toBe(0);
    await page.screenshot({ path: join(shots, 'compare-previews.png') });
    // V5 restored V1: the same files, so the same picture.
    const newer = page.getByLabel('較新');
    const v5 = await newer.locator('option', { hasText: /^V5 · / }).getAttribute('value');
    await newer.selectOption(v5 ?? '');
    await page.getByText('兩個版本的畫面完全相同').waitFor({ timeout: 30_000 });
  });

  it('shows a changed PNG as both versions hold it', async () => {
    write('img/hero.png', makePng(1200, 600, 90));
    await saveVersion('New hero');
    await openProject();
    await page.getByRole('listitem').filter({ hasText: 'New hero' }).click();
    await page.getByRole('button', { name: '與上一筆比較' }).click();
    await page.getByRole('heading', { name: '比較版本' }).waitFor();
    // The first changed file opens by itself.
    const row = page.getByRole('button', { name: /img\/hero\.png/ });
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    // Before: the fixture's few bytes were never a readable PNG.
    await page.getByText('這不是 Draft Tide 能讀取的 PNG 或 JPEG 圖片。').waitFor({ timeout: 30_000 });
    const after = page.getByRole('img', { name: '之後 的畫面預覽' });
    await after.waitFor({ timeout: 30_000 });
    await after.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'compare-image.png') });
  });

  it("keeps a design's page away from the network, other files and the app", async () => {
    // Anything reaching these counts: TCP (HTTP, WebSocket) and UDP (WebRTC).
    let tcp = 0;
    let udp = 0;
    const server = createServer((socket) => {
      tcp++;
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
    const port = (server.address() as { port: number }).port;
    const dgram = createSocket('udp4');
    dgram.on('message', () => udp++);
    await new Promise<void>((r) => dgram.bind(0, '0.0.0.0', r));
    const udpPort = dgram.address().port;
    const lan =
      Object.values(networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';

    write(
      'probe.html',
      `<!doctype html><meta charset="utf-8"><title>probe</title>
<link rel="dns-prefetch" href="//probe-dns.example"><link rel="prefetch" href="http://127.0.0.1:${port}/prefetch">
<h1>Isolation probe</h1><img src="http://${lan}:${port}/img"><iframe src="https://example.com/frame"></iframe>
<script>
const report = (k, v) => fetch('/__probe__/' + encodeURIComponent(k + '=' + v)).catch(() => {});
report('require', typeof require); report('process', typeof process); report('bridge', typeof window.draftTide);
const tries = { external: 'https://example.com/', loopback: 'http://127.0.0.1:${port}/f', lan: 'http://${lan}:${port}/f',
  file: 'file:///etc/hosts', gui: 'app://gui/index.html', traversal: 'dt-preview://job/../../../../etc/hosts',
  encoded: 'dt-preview://job/%2e%2e%2f%2e%2e%2fetc%2fhosts', own: 'dt-preview://job/css/site.css' };
for (const [k, u] of Object.entries(tries)) fetch(u).then((r) => r.ok ? r.text().then((t) => report(k, 'read')) : report(k, 'status' + r.status), () => report(k, 'blocked'));
try { const ws = new WebSocket('ws://127.0.0.1:${port}/ws'); ws.onopen = () => report('ws', 'open'); ws.onerror = () => report('ws', 'blocked'); } catch { report('ws', 'threw'); }
report('popup', window.open('https://example.com/popup') ? 'opened' : 'null');
navigator.geolocation.getCurrentPosition(() => report('geo', 'granted'), () => report('geo', 'denied'));
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${lan}:${udpPort}' }, { urls: 'stun:127.0.0.1:${udpPort}' }] });
pc.createDataChannel('x'); pc.onicecandidate = (e) => { if (e.candidate && e.candidate.type !== 'host') report('ice', e.candidate.type); };
pc.createOffer().then((o) => pc.setLocalDescription(o));
setTimeout(() => { location.href = 'https://example.com/away'; }, 50);
</script>`,
    );
    setEntry('probe.html');
    const probe = await saveVersion('Probe');
    const art = await invoke<Artifact>('snapshot.preview', { projectId, version: probe });
    expect(art.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    server.close();
    dgram.close();

    const results = Object.fromEntries(
      art.data.missing.entries
        .filter((m) => m.path.startsWith('__probe__/'))
        .map((m) => m.path.slice('__probe__/'.length).split('=') as [string, string]),
    );
    expect(results).toMatchObject({
      require: 'undefined',
      process: 'undefined',
      bridge: 'undefined',
      external: 'blocked',
      loopback: 'blocked',
      lan: 'blocked',
      file: 'blocked',
      gui: 'blocked',
      // `..` is resolved by the URL; encoded `..` is refused by the Engine.
      traversal: 'status404',
      encoded: 'status404',
      own: 'read',
      ws: 'blocked',
      popup: 'null',
      geo: 'denied',
    });
    expect(results['ice']).toBeUndefined();
    expect({ tcp, udp }).toEqual({ tcp: 0, udp: 0 });
    const kinds = new Set(art.data.blocked.entries.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(['navigation', 'network', 'permission', 'popup']);
    expect(art.data.incomplete).toBe(true);
  });

  it('says why a version has no picture; the version itself is fine', async () => {
    setEntry('css/site.css');
    await saveVersion('Odd entry');
    await openProject();
    await page.getByRole('listitem').filter({ hasText: 'Odd entry' }).click();
    const panel = page.getByLabel('版本詳細內容');
    await panel.getByText('預覽頁面不是 HTML 網頁，也不是 PNG / JPEG 圖片。').waitFor({ timeout: 30_000 });
    await panel.getByRole('button', { name: '回復到此版' }).waitFor();
    await page.getByText('沒有新的變更').waitFor();
    await page.screenshot({ path: join(shots, 'preview-unsupported.png') });
    setEntry('index.html');
    await saveVersion('Entry back');
  });

  it('shows the preview cache in settings and clears it', async () => {
    await nav('設定與診斷').click();
    const card = page.getByRole('region', { name: '畫面預覽' }).or(page.locator('section', { hasText: '畫面預覽' }));
    await card.getByText('可以使用').first().waitFor();
    await page.screenshot({ path: join(shots, 'settings-previews.png') });
    const cache = join(dataDir, 'projects', projectId, 'cache', 'previews');
    const before = readdirSync(cache);
    expect(before.length).toBeGreaterThan(0);
    const clicked = Date.now();
    await page.getByRole('button', { name: '清除預覽快取' }).click();
    await page.getByText(/^已清除 \d+ 個預覽/).waitFor();
    // None of the old files stay (one the app asks for again is made anew).
    const kept = readdirSync(cache).filter((f) => before.includes(f) && statSync(join(cache, f)).mtimeMs < clicked);
    expect(kept).toEqual([]);
  });
});

describe('設定與診斷: storage and diagnostics', () => {
  it('shows what Draft Tide takes, and saves a de-identified diagnostics report', async () => {
    await nav('設定與診斷').click();
    const storage = page.getByRole('region', { name: '容量' });
    await storage.getByText('各專案的歷史').waitFor();
    await storage.getByText('Pricing page').waitFor();
    await storage
      .getByText(/^歷史 /)
      .first()
      .waitFor();
    const out = join(mkdtempSync(join(tmpdir(), 'dt-e2e-diag-')), 'report.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, out);
    const card = page.getByRole('region', { name: '診斷資訊' });
    await card.getByRole('button', { name: '匯出診斷資訊…' }).click();
    await card.getByText('已儲存「report.json」', { exact: false }).waitFor();
    const text = readFileSync(out, 'utf8');
    const report = DiagnosticsReport.parse(JSON.parse(text));
    expect(report.projects.length).toBeGreaterThan(0);
    const ids = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        draftTide: { invoke(op: string, payload: unknown): Promise<{ data: { projectId: string }[] }> };
      };
      return (await w.draftTide.invoke('project.list', {})).data.map((p) => p.projectId);
    });
    expect(ids.length).toBeGreaterThan(0);
    for (const secret of [designDir, dataDir, 'Pricing page', ...ids]) expect(text, secret).not.toContain(secret);
    await card.getByText('檢視內容').click();
    await card.getByText('"draft-tide-diagnostics"', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'settings-diagnostics.png'), fullPage: true });
    // Cancelling the dialog saves nothing and says nothing went wrong.
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' });
    });
    await card.getByRole('button', { name: '匯出診斷資訊…' }).click();
    await expect.poll(() => card.getByRole('alert').count()).toBe(0);
    rmSync(dirname(out), { recursive: true, force: true });
  });
});

describe('a folder that cannot be connected as it is', () => {
  it('explains why in designer terms and offers nothing to confirm', async () => {
    const blocked = realpathSync(mkdtempSync(join(tmpdir(), 'dt-e2e-blocked-')));
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: blocked, env, encoding: 'utf8' });
    writeFileSync(join(blocked, 'index.html'), '<h1>x</h1>\n');
    git('init', '--quiet');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'first');
    git('checkout', '--quiet', '--detach');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
    }, blocked);
    await nav('專案').click();
    await page.getByRole('button', { name: /開啟設計資料夾/ }).click();
    await page.getByText('目前不在任何 branch 上（detached HEAD）').waitFor();
    expect(await page.getByRole('button', { name: /確認並保存第一版/ }).isDisabled()).toBe(true);
    await page.getByText('處理上面的問題、再檢查一次之後', { exact: false }).waitFor();
    expect(await page.getByText('0 個檔案').count()).toBe(0);
    await page.screenshot({ path: join(shots, 'review-blocked.png') });
    expect(existsSync(join(blocked, '.drafttide.json'))).toBe(false);
    rmSync(blocked, { recursive: true, force: true });
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
