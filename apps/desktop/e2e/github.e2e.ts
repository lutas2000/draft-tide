// GitHub sign-in and sync in the app (M1-07), against a fake GitHub on
// loopback: the app's Engine gets it through DRAFT_TIDE_TEST_GITHUB (e2e and
// development builds only). The device flow is approved by the fake, the
// native folder picker is answered from Main, and another computer is the
// user's own Git pushing to the fake.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeProjectConfig, type ProjectId } from '@draft-tide/contracts';
import { startFakeGitHub, type FakeGitHub } from '../../../fixtures/fake-github.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
const shots = join(root, 'test-results');

const dataDir = mkdtempSync(join(tmpdir(), 'dt-e2e-gh-'));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dt-e2e-gh-work-')));
const designDir = join(scratch, 'design');
const gitConfig = join(scratch, 'gitconfig');
let gh: FakeGitHub;
let app: ElectronApplication;
let page: Page;

writeFileSync(
  gitConfig,
  '[user]\n\tname = Engineer\n\temail = eng@example.com\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[protocol "file"]\n\tallow = always\n',
);
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
}
// Over the network to the fake, which lives in this process: never sync.
function gitAsync(cwd: string, ...args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? -1));
  });
}
function write(dir: string, rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
const nav = (name: string) => page.getByRole('navigation', { name: '主要' }).getByRole('button', { name });
const pick = (folder: string) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  gh = await startFakeGitHub({ rootDir: join(scratch, 'github') });
  gh.createRepo('designer', 'pricing');
  mkdirSync(designDir);
  write(designDir, 'index.html', '<h1>Pricing</h1>\n');
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'dist-e2e', 'main', 'main.mjs')],
    env: {
      ...(process.env as Record<string, string>),
      DRAFT_TIDE_DATA_DIR: dataDir,
      DRAFT_TIDE_ENGINE_IDLE_MS: '1500',
      DRAFT_TIDE_TEST_GITHUB: gh.env,
    },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.getByText('引擎已連線').waitFor();
});

afterAll(async () => {
  await app?.close();
  try {
    const d = JSON.parse(readFileSync(join(dataDir, 'runtime', 'engine.json'), 'utf8')) as { pid: number };
    process.kill(d.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  await gh?.close();
  for (const d of [dataDir, scratch]) rmSync(d, { recursive: true, force: true });
});

describe('GitHub in the app', () => {
  it('signs in with the device code', async () => {
    await nav('帳號與同步').click();
    await page.getByRole('button', { name: '登入 GitHub' }).click();
    await page.getByLabel('驗證碼').getByText('WDJB-MJHT').waitFor();
    await page.screenshot({ path: join(shots, 'github-sign-in-code.png') });
    // The fake approves at its next poll.
    await page.getByText('Dee Signer（@designer）').waitFor({ timeout: 20_000 });
    await page.getByText(`${gh.user.id}+designer@users.noreply.github.com`, { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'github-signed-in.png') });
  });

  it('connects an empty repository after the first-push review, then pushes each save', async () => {
    await pick(designDir);
    await nav('專案').click();
    await page.getByRole('button', { name: /開啟設計資料夾/ }).click();
    await page.getByRole('heading', { name: '確認保存範圍' }).waitFor();
    await page.getByLabel('專案名稱').fill('Pricing');
    await page.getByRole('button', { name: /確認並保存第一版/ }).click();
    await page.getByRole('heading', { name: '版本歷史' }).waitFor();

    await page.getByText('沒有異地備份').first().waitFor();
    await page.getByRole('button', { name: '連接 GitHub repo…' }).click();
    const dialog = page.getByRole('dialog', { name: '連接 GitHub repo' });
    await dialog.getByRole('radio', { name: /designer\/pricing/ }).check();
    await dialog.getByRole('button', { name: '檢查這個 repo' }).click();
    await dialog
      .getByText('將推送 1 個版本', { exact: false })
      .waitFor({ timeout: 15_000 })
      .catch(async (e: unknown) => {
        writeFileSync(join(shots, 'github-connect-failure.txt'), await dialog.innerText());
        await page.screenshot({ path: join(shots, 'github-connect-failure.png') });
        throw e;
      });
    await dialog.getByText('repo 是空的', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'github-first-push-review.png') });
    await dialog.getByRole('button', { name: '連接並推送' }).click();
    await dialog.getByText('已連接 designer/pricing').waitFor({ timeout: 20_000 });
    await dialog.getByRole('button', { name: '完成' }).click();
    await page.getByText('已同步').first().waitFor();
    expect(gh.branchTip('designer', 'pricing', 'main')).toBe(git(designDir, 'rev-parse', 'HEAD').trim());

    write(designDir, 'index.html', '<h1>Pricing v2</h1>\n');
    await page.getByRole('button', { name: '保存版本' }).click();
    await page.getByLabel('版本名稱', { exact: false }).fill('v2');
    await page.getByRole('dialog').getByRole('button', { name: '保存版本' }).click();
    await page.getByText('已保存「v2」').waitFor();
    await expect
      .poll(() => gh.branchTip('designer', 'pricing', 'main'), { timeout: 20_000 })
      .toBe(git(designDir, 'rev-parse', 'HEAD').trim());
    await page.screenshot({ path: join(shots, 'github-synced.png') });
  });

  it("gets another computer's newer version", async () => {
    const other = join(scratch, 'other');
    const token = gh.issueAccessToken();
    const url = `${gh.endpoints.git}/designer/pricing.git`.replace('http://', `http://x-access-token:${token}@`);
    expect(await gitAsync(scratch, 'clone', '--quiet', url, other)).toBe(0);
    write(other, 'index.html', '<h1>Pricing from the other computer</h1>\n');
    git(other, 'commit', '--quiet', '-am', 'edited elsewhere');
    expect(await gitAsync(other, 'push', '--quiet', 'origin', 'HEAD:main')).toBe(0);

    await page.getByRole('button', { name: '取得更新…' }).click();
    const dialog = page.getByRole('dialog', { name: '取得 GitHub 的更新' });
    await dialog.getByText('GitHub 上有 1 個新的 commit', { exact: false }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, 'github-pull-plan.png') });
    await dialog.getByRole('button', { name: '取得更新' }).click();
    await page.getByText('已取得 GitHub 的更新', { exact: false }).waitFor({ timeout: 20_000 });
    expect(readFileSync(join(designDir, 'index.html'), 'utf8')).toBe('<h1>Pricing from the other computer</h1>\n');
    expect(git(designDir, 'status', '--porcelain')).toBe('');
    await page.getByText('外部變更').first().waitFor();
  });

  it('opens a project from GitHub into an empty folder', async () => {
    // A project another designer synced: its own repository and settings.
    const repo = gh.createRepo('designer', 'landing');
    const seed = join(scratch, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '--quiet');
    write(seed, 'index.html', '<h1>Landing</h1>\n');
    write(
      seed,
      '.drafttide.json',
      serializeProjectConfig({
        schemaVersion: 1,
        projectId: randomUUID() as ProjectId,
        name: 'Landing',
        entryFiles: ['index.html'],
        excludeDirNames: [],
        excludeFilePatterns: [],
      }),
    );
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'landing');
    git(seed, 'push', '--quiet', repo.dir, 'HEAD:refs/heads/main');

    const target = join(scratch, 'opened');
    mkdirSync(target);
    await pick(target);
    await nav('專案').click();
    await page.getByRole('button', { name: /從 GitHub 開啟/ }).click();
    const dialog = page.getByRole('dialog', { name: '從 GitHub 開啟專案' });
    await dialog.getByRole('radio', { name: /designer\/landing/ }).check();
    await dialog.getByRole('button', { name: '選擇資料夾…' }).click();
    await dialog.getByText(target).waitFor();
    await dialog.getByRole('button', { name: '檢查' }).click();
    await dialog.getByText('開到空資料夾', { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, 'github-open-plan.png') });
    await dialog.getByRole('button', { name: '開啟' }).click();
    await page.getByRole('heading', { name: 'Landing', level: 1 }).waitFor({ timeout: 20_000 });
    expect(readdirSync(target).sort()).toEqual(['.drafttide.json', '.git', 'index.html']);
    expect(git(target, 'status', '--porcelain')).toBe('');
    await page.getByText('已同步').first().waitFor();
  });

  it('never leaves a token in the data directory', () => {
    const leaks: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && gh.tokens.some((t) => readFileSync(p).includes(t))) leaks.push(p);
      }
    };
    walk(dataDir);
    expect(leaks).toEqual([]);
  });
});
