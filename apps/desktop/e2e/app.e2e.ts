import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function cliEnvelope(...args: string[]): { ok: boolean; data: unknown; error: { code: string } | null } {
  const r = spawnSync(process.execPath, [companionCli, '--json', '--data-dir', dataDir, ...args], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as { ok: boolean; data: unknown; error: { code: string } | null };
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
  rmSync(designDir, { recursive: true, force: true });
});

describe('desktop app', () => {
  it('opens on the projects screen with the Engine connected', async () => {
    await expect.poll(() => page.title()).toBe('Draft Tide');
    await page.getByText('引擎已連線').waitFor();
    await page.getByText('還沒有專案').waitFor();
    // Not-yet-built entry points are visible but marked, never clickable.
    expect(await page.getByText('尚未提供').count()).toBe(2);
    expect(await page.getByRole('button', { name: /開啟設計資料夾/ }).isEnabled()).toBe(true);
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
      bridge: ['chooseFolder', 'connectionState', 'invoke', 'onConnection', 'onEvent', 'reconnect'],
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

  it('shows the account screen without pretending sync exists', async () => {
    await page.getByRole('button', { name: '帳號與同步' }).click();
    await page.getByText('沒有異地備份', { exact: false }).waitFor();
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
