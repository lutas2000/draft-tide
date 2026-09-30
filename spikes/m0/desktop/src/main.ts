// Electron main for the M0 packaging spike. Two modes share this entry:
//  - app: trusted GUI shell (React prototype over app://), restricted preload,
//    desktop confirmation channel to the Engine (bundled Node, not Electron's).
//  - --dt-preview-host: isolated offscreen renderer for one preview job.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { connectEngine, type EngineConnection } from '../../core/src/engine/client.ts';
import { makePng } from '../../core/src/storage/fixtures.ts';

const isPreviewHost = process.argv.includes('--dt-preview-host');
const resources = app.isPackaged ? process.resourcesPath : path.resolve(import.meta.dirname, '..', '..', 'core', 'build');
const bundledNode = path.join(resources, 'node', 'bin', 'node');
const engineEntry = path.join(resources, 'companion', 'engine.mjs');
const guiDir = path.join(resources, 'gui');
const log = (m: string) => process.stderr.write(`[desktop${isPreviewHost ? ':preview' : ''} ${process.pid}] ${m}\n`);

if (isPreviewHost) runPreviewHost();
else runApp();

// ------------------------------------------------------------------ app mode
function runApp(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const smokeOut = process.env['DRAFT_TIDE_SMOKE_OUT'];
  const GUI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
  let engine: EngineConnection | null = null;
  let win: BrowserWindow | null = null;
  const guiConsole: string[] = [];

  async function getEngine(): Promise<EngineConnection> {
    if (engine) return engine;
    const c = await connectEngine({ client: 'desktop', nodePath: bundledNode, engineEntry });
    await c.call('events.subscribe');
    c.onEvent((e) => {
      if (e['event'] === 'approval.requested' && !smokeOut) void confirmRestore(c, e['operation'] as Record<string, any>);
    });
    engine = c;
    return c;
  }

  // The trusted confirmation surface: a native dialog owned by Main, showing
  // the Engine-computed summary. Agents can only request it.
  async function confirmRestore(c: EngineConnection, op: Record<string, any>): Promise<void> {
    const s = op['summary'] ?? {};
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['回復到此版', '拒絕'],
      defaultId: 1,
      cancelId: 1,
      title: 'Draft Tide',
      message: `${op['requestedBy'] === 'mcp' ? '外部 Agent（MCP）' : op['requestedBy'] === 'cli' ? '命令列工具' : '應用程式'}要求回復一個舊版本`,
      detail: [
        `會覆寫 ${s.overwrite ?? 0} 個檔案、新增 ${s.add ?? 0} 個、刪除 ${s.delete ?? 0} 個。`,
        s.unsavedChangesWillBeProtected ? '目前尚未保存的修改會先保存為「回復前保護版本」。' : '目前內容已保存，不需要額外保護版本。',
        '保存範圍以外的檔案不會被刪除。請先停止會寫入這個資料夾的工具。',
      ].join('\n'),
    });
    await c.call('approval.decide', { operationId: op['operationId'], decision: r.response === 0 ? 'approve' : 'deny' });
  }

  ipcMain.handle('draftTide:engineInfo', async (event) => {
    // Only the app's own GUI frame may use the bridge.
    if (!event.senderFrame?.url.startsWith('app://gui/')) throw new Error('untrusted sender');
    return (await getEngine()).call('engine.info');
  });

  app.whenReady().then(async () => {
    protocol.handle('app', async (req) => {
      const url = new URL(req.url);
      if (url.host !== 'gui') return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const abs = path.resolve(guiDir, rel);
      if (!abs.startsWith(guiDir + path.sep)) return new Response('forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(abs).toString());
      const headers = new Headers(res.headers);
      headers.set('content-security-policy', GUI_CSP);
      return new Response(res.body, { status: res.status, headers });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: !smokeOut,
      title: 'Draft Tide',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    if (smokeOut) win.webContents.on('console-message', (e) => guiConsole.push(String((e as unknown as { message: string }).message).slice(0, 300)));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('app://gui/')) e.preventDefault();
    });
    await win.loadURL('app://gui/index.html');
    if (smokeOut) await smoke(win, smokeOut, getEngine, guiConsole).catch((e: unknown) => {
      writeFileSync(path.join(smokeOut, 'smoke-error.txt'), String((e as Error).stack ?? e));
    });
    if (smokeOut) {
      engine?.close();
      app.quit();
    }
  });
  app.on('window-all-closed', () => {
    engine?.close();
    app.quit();
  });
}

async function smoke(win: BrowserWindow, out: string, getEngine: () => Promise<EngineConnection>, guiConsole: string[]): Promise<void> {
  mkdirSync(out, { recursive: true });
  const wc = win.webContents;
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await settle(800);
  const renderer = await wc.executeJavaScript(`(async () => ({
    require: typeof require, process: typeof process, module: typeof module,
    bridgeKeys: Object.keys(window.draftTide ?? {}),
    engineInfo: await window.draftTide.engineInfo(),
    title: document.title, origin: location.origin,
  }))()`);
  await settle(2500);
  writeFileSync(path.join(out, 'gui-start.png'), (await wc.capturePage()).toPNG());
  const frames = await wc.executeJavaScript(`[...document.querySelectorAll('iframe')].map((f) => ({ w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, len: (f.srcdoc || '').length }))`);
  // Open the settings / diagnostics screen, which renders 引擎狀態 from the bridge.
  await wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button, a')].find((x) => /設定|診斷/.test(x.textContent ?? '')); b?.click(); return !!b; })()`);
  await settle(1500);
  writeFileSync(path.join(out, 'gui-settings.png'), (await wc.capturePage()).toPNG());
  const settingsText: string = await wc.executeJavaScript('document.body.innerText');

  // Engine + Preview Host round trip on a small design with an attack page.
  const eng = await getEngine();
  const design = path.join(out, 'design');
  mkdirSync(design, { recursive: true });
  writeFileSync(path.join(design, 'index.html'), `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><header><h1>Aurora 定價</h1><p>讓想法流動，讓每一稿留下。</p></header><main><section class="plan"><h2>Starter</h2><p class="price">$9</p></section><section class="plan featured"><h2>Team</h2><p class="price">$29</p></section><section class="plan"><h2>Scale</h2><p class="price">$99</p></section></main><img src="hero.png" alt=""></body></html>\n`);
  writeFileSync(path.join(design, 'style.css'), `body{font-family:system-ui,-apple-system,"PingFang TC",sans-serif;margin:0;background:#f6f3ee;color:#1c2430}header{padding:48px 64px 16px}h1{font-size:44px;margin:0}main{display:flex;gap:24px;padding:24px 64px}.plan{flex:1;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px #0002}.featured{outline:3px solid #2f6f73}.price{font-size:32px;font-weight:700;color:#2f6f73}img{display:block;margin:8px 64px;width:480px;height:120px;object-fit:cover;border-radius:12px}\n`);
  writeFileSync(path.join(design, 'hero.png'), makePng(480, 120, 3, 0.3));
  writeFileSync(path.join(design, 'attack.html'), ATTACK_HTML);
  const bound = await eng.call<{ projectId: string; baselineSnapshotId: string }>('project.bind', { root: design, entryFiles: ['index.html'], displayName: 'Aurora (smoke)' });
  const prep = await eng.call<{ workspace: string }>('preview.prepare', { projectId: bound.projectId, snapshotId: bound.baselineSnapshotId });
  const t0 = Date.now();
  const page = await runPreviewJob({ workspace: prep.workspace, entry: 'index.html', out: path.join(out, 'preview-index.png'), allowScripts: true, timeoutMs: 15000 });
  const pageMs = Date.now() - t0;
  const attack = await runPreviewJob({ workspace: prep.workspace, entry: 'attack.html', out: path.join(out, 'preview-attack.png'), allowScripts: true, timeoutMs: 15000 });
  writeFileSync(path.join(out, 'smoke-result.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, electronNode: process.versions.node, packaged: app.isPackaged, resources, renderer, settingsShowsEngine: settingsText.includes(String(renderer.engineInfo?.instanceId ?? '???').slice(0, 8)) || settingsText.includes('引擎'), previewIndex: { ...page, ms: pageMs }, previewAttack: attack, guiFrames: frames, guiConsole }, null, 2));
}

function runPreviewJob(job: { workspace: string; entry: string; out: string; allowScripts: boolean; timeoutMs: number }): Promise<Record<string, unknown>> {
  const jobFile = path.join(tmpdir(), `dt-preview-job-${randomUUID()}.json`);
  writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
  // Packaged: the app executable itself; dev: electron + app path.
  const args = app.isPackaged ? ['--dt-preview-host', jobFile] : [app.getAppPath(), '--dt-preview-host', jobFile];
  return new Promise((resolve) => {
    // No DRAFT_TIDE_* variables, tokens or data dir reach the host.
    const child = spawn(process.execPath, args, { env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const kill = setTimeout(() => child.kill('SIGKILL'), job.timeoutMs + 5000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const resFile = `${job.out}.json`;
      resolve(existsSync(resFile) ? { exitCode: code, ...(JSON.parse(readFileSync(resFile, 'utf8')) as Record<string, unknown>) } : { exitCode: code, error: 'no result', stderr: stderr.slice(-2000) });
    });
  });
}

// ---------------------------------------------------------- preview host mode
const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
};
const PREVIEW_FILE_BUDGET = 64 * 1024 * 1024; // preview-only budget, never a save limit

function runPreviewHost(): void {
  const jobFile = process.argv[process.argv.indexOf('--dt-preview-host') + 1] ?? '';
  const job = JSON.parse(readFileSync(jobFile, 'utf8')) as { workspace: string; entry: string; out: string; allowScripts: boolean; timeoutMs: number };
  app.setPath('userData', path.join(tmpdir(), `dt-preview-${process.pid}`));
  app.commandLine.appendSwitch('lang', 'en-US');
  protocol.registerSchemesAsPrivileged([{ scheme: 'dt-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const blocked: string[] = [];
  const permissions: string[] = [];
  const consoleLines: string[] = [];
  const finish = (result: Record<string, unknown>) => {
    writeFileSync(`${job.out}.json`, JSON.stringify({ ...result, blocked, permissionsDenied: permissions, console: consoleLines.slice(0, 50), renderer: { electron: process.versions.electron, chrome: process.versions.chrome }, settings: { viewport: '1280x800', scale: 1, locale: 'en-US', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }, null, 2));
    app.exit(0);
  };
  setTimeout(() => finish({ ok: false, error: 'PREVIEW_FAILED: timeout' }), job.timeoutMs).unref();
  app.on('window-all-closed', () => undefined);

  app.whenReady().then(async () => {
    const ws = path.resolve(job.workspace);
    const ses = session.fromPartition(`preview-${randomUUID()}`, { cache: false }); // in-memory, ephemeral
    ses.protocol.handle('dt-preview', (req) => {
      const u = new URL(req.url);
      if (u.host !== 'job') return new Response('not found', { status: 404 });
      let rel: string;
      try {
        rel = decodeURIComponent(u.pathname);
      } catch {
        return new Response('bad request', { status: 400 });
      }
      const abs = path.resolve(ws, `.${rel}`);
      if (rel.includes('\0') || (abs !== ws && !abs.startsWith(ws + path.sep))) {
        blocked.push(`path-escape ${rel}`);
        return new Response('forbidden', { status: 403 });
      }
      const type = PREVIEW_TYPES[path.extname(abs).toLowerCase()];
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        return new Response('not found', { status: 404 });
      }
      if (!type || !st.isFile() || st.size > PREVIEW_FILE_BUDGET) return new Response('not found', { status: 404 });
      return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
        headers: { 'content-type': type, 'content-security-policy': "default-src dt-preview: data: blob: 'unsafe-inline'; connect-src dt-preview:; frame-src 'none'; worker-src 'none'" },
      });
    });
    ses.webRequest.onBeforeRequest((d, cb) => {
      const ok = d.url.startsWith('dt-preview://job/') || d.url.startsWith('data:') || d.url.startsWith('blob:');
      if (!ok) blocked.push(`request ${d.url.slice(0, 120)}`);
      cb({ cancel: !ok });
    });
    ses.setPermissionRequestHandler((_wc, perm, cb) => {
      permissions.push(perm);
      cb(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, javascript: job.allowScripts, webSecurity: true, spellcheck: false, navigateOnDragDrop: false },
    });
    const wc = win.webContents;
    const entryUrl = `dt-preview://job/${job.entry.split('/').map(encodeURIComponent).join('/')}`;
    wc.setWindowOpenHandler((d) => {
      blocked.push(`window.open ${d.url.slice(0, 120)}`);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (url !== entryUrl) {
        e.preventDefault();
        blocked.push(`navigate ${url.slice(0, 120)}`);
      }
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('console-message', (e) => consoleLines.push(String((e as unknown as { message: string }).message).slice(0, 300)));
    try {
      await win.loadURL(entryUrl);
      await new Promise((r) => setTimeout(r, 1200));
      const img = await wc.capturePage();
      writeFileSync(job.out, img.toPNG());
      const probe = await wc.executeJavaScript('JSON.stringify(window.__dtProbe ?? null)');
      finish({ ok: true, png: path.basename(job.out), size: img.getSize(), finalUrl: wc.getURL(), probe: JSON.parse(probe as string) as unknown });
    } catch (e) {
      finish({ ok: false, error: `PREVIEW_FAILED: ${(e as Error).message}` });
    }
  });
}

const ATTACK_HTML = `<!doctype html><meta charset="utf-8"><title>isolation probe</title>
<style>body{font:16px system-ui;padding:32px}</style><h1>Preview isolation probe</h1><pre id="out">running…</pre>
<script>
const r = {}; window.__dtProbe = r;
r.require = typeof require; r.process = typeof process; r.draftTide = typeof window.draftTide; r.ipc = typeof window.ipcRenderer;
const tries = [
  ['external', 'https://example.com/'], ['loopback', 'http://127.0.0.1:9/'], ['privateNet', 'http://192.168.1.1/'],
  ['file', 'file:///etc/hosts'], ['traversal', 'dt-preview://job/../../../../etc/hosts'],
  ['encodedTraversal', 'dt-preview://job/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fhosts'], ['absolute', 'dt-preview://job/' + encodeURIComponent('/etc/hosts')],
  ['appGui', 'app://gui/index.html'], ['ownAsset', 'dt-preview://job/style.css'],
];
Promise.all(tries.map(([k, u]) => fetch(u).then((res) => res.ok ? res.text().then((t) => { r[k] = 'READ ' + t.length; }) : (r[k] = 'status ' + res.status)).catch(() => { r[k] = 'blocked'; })))
  .then(() => { r.done = true; document.getElementById('out').textContent = JSON.stringify(r, null, 2); });
try { r.popup = window.open('https://example.com') ? 'opened' : 'null'; } catch (e) { r.popup = 'threw'; }
if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').then(() => { r.serviceWorker = 'registered'; }, () => { r.serviceWorker = 'refused'; }); else r.serviceWorker = 'unavailable';
navigator.geolocation ? navigator.geolocation.getCurrentPosition(() => { r.geolocation = 'granted'; }, () => { r.geolocation = 'denied'; }) : (r.geolocation = 'unavailable');
const img = new Image(); img.onload = () => { r.remoteImage = 'loaded'; }; img.onerror = () => { r.remoteImage = 'blocked'; }; img.src = 'https://example.com/pixel.png';
setTimeout(() => { location.href = 'https://example.com/'; }, 200);
</script>
`;
