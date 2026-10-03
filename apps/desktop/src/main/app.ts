// Electron Main: the trusted shell. It owns the window, native dialogs and the
// desktop-channel session with the Engine. It never opens the database, runs
// Git or runs a writable core. Nothing here runs until runApp(): the same
// binary may be starting as a Preview Host instead (main.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  DiagnosticsReport,
  DtError,
  OPERATIONS,
  errorEnvelope,
  isOperationName,
  isSingleLine,
  toErrorInfo,
} from '@draft-tide/contracts';
import { defaultDataDir, desktopProfileDir, packagedLayout, resolveDataDir } from '@draft-tide/engine-client';
import { IPC, type AgentSetup, type ConnectionState, type DiagnosticsExport } from '../shared/bridge.ts';
import { BUILD } from './build-info.ts';
import { DesktopEngine } from './engine.ts';

const GUI_DIR = resolve(import.meta.dirname, '..', 'gui');
const GUI_ROOT_URL = BUILD.guiDevUrl ? `${new URL(BUILD.guiDevUrl).origin}/` : 'app://gui/';
const GUI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let win: BrowserWindow | null = null;
let engine: DesktopEngine;
const isGuiUrl = (url: string) => url.startsWith(GUI_ROOT_URL);

// Where this installation's CLI, MCP server and Skill are (M1 plan §4.1). The
// CLI and MCP server run on the companion Node; the Skill folder ships beside
// them (in the repository for development builds, in the app's resources from
// M1-09). A data directory other than the default is passed as --data-dir, so
// an agent reaches the same Engine as this window.
function agentSetup(): AgentSetup {
  const where = BUILD.companion
    ? { node: BUILD.companion.nodePath, cli: BUILD.companion.cliEntry, skillDir: BUILD.companion.skillDir }
    : packagedLayout(process.resourcesPath);
  const dataDir = resolveDataDir();
  const custom = dataDir !== defaultDataDir();
  // Every companion process runs with --disable-sigusr1 (CLAUDE.md "Every
  // companion process").
  const cli = ['--disable-sigusr1', where.cli];
  return {
    command: where.node,
    args: custom ? [...cli, '--data-dir', dataDir] : cli,
    skillDir: existsSync(join(where.skillDir, 'SKILL.md')) ? where.skillDir : null,
    dataDir: custom ? dataDir : null,
  };
}

// Chromium's profile (Electron's userData and session data: cookies, local
// storage, caches) goes to its own subfolder of the data directory this window
// uses, never beside the Engine's state.sqlite. Before anything reads the
// path: the single-instance lock is kept there, so one app instance runs per
// data store.
function useDesktopProfile(): void {
  const profile = desktopProfileDir(resolveDataDir());
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setPath('crashDumps', join(profile, 'Crashpad'));
}

// An agent asked for something only the user does here (request.waiting),
// or the app was opened again (a second instance, which may be the Engine
// opening it for a request): the window comes forward, at most this often.
// The request itself shows as a banner on every screen; nothing is answered
// for the user.
const ATTEND_EVERY_MS = 3_000;
let attendedAt = 0;

function attend(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (win.isFocused() || Date.now() - attendedAt < ATTEND_EVERY_MS) return;
  attendedAt = Date.now();
  win.focus();
  app.focus({ steal: true });
  // Where the system keeps another app in front, the Dock icon or the
  // taskbar asks for attention instead.
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else if (!win.isFocused()) {
    win.flashFrame(true);
    win.once('focus', () => win?.flashFrame(false));
  }
}

export function runApp(): void {
  useDesktopProfile();
  engine = new DesktopEngine({
    onState: (state: ConnectionState) => win?.webContents.send(IPC.connection, state),
    onEvent: (event) => {
      if (event.event.name === 'request.waiting') attend();
      win?.webContents.send(IPC.event, event);
    },
  });

  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  // Only the app's own top-level GUI frame may use the bridge.
  function trusted(event: IpcMainInvokeEvent): boolean {
    return (
      win !== null &&
      event.sender === win.webContents &&
      event.senderFrame !== null &&
      event.senderFrame === win.webContents.mainFrame &&
      isGuiUrl(event.senderFrame.url)
    );
  }

  // Folders the user picked in the native dialog during this run. Reviewing or
  // connecting a folder needs one of these: a path typed into the renderer (or
  // injected into it) is never authorization (M1 plan §6.2).
  const chosenFolders = new Set<string>();
  // The operation, and the field naming the folder: a folder to connect, or
  // the empty folder a project from GitHub is opened into.
  const NEEDS_CHOSEN_FOLDER: ReadonlyMap<string, string> = new Map([
    ['project.review', 'root'],
    ['project.bind', 'root'],
    ['remote.openPlan', 'destination'],
  ]);

  ipcMain.handle(IPC.invoke, async (event, op: unknown, payload: unknown) => {
    if (!trusted(event)) return errorEnvelope(new DtError('UNAUTHENTICATED', 'untrusted sender'));
    if (typeof op !== 'string' || !isOperationName(op) || !OPERATIONS[op].desktop) {
      return errorEnvelope(new DtError('UNKNOWN_OPERATION', `not an app operation: ${String(op).slice(0, 64)}`));
    }
    const field = NEEDS_CHOSEN_FOLDER.get(op);
    if (field !== undefined) {
      const root = (payload as Record<string, unknown> | null)?.[field];
      if (typeof root !== 'string' || !chosenFolders.has(root)) {
        return errorEnvelope(
          new DtError('INVALID_ARGUMENT', 'choose the folder in Draft Tide first', { reason: 'folder-not-chosen' }),
        );
      }
    }
    return engine.invoke(op, payload);
  });
  // Where the dialog opens: an absolute, single-line path, else nowhere in
  // particular. It comes from the renderer (an agent's request names a folder),
  // so it is only a starting point and never authorization.
  function dialogStart(defaultPath: unknown): string | undefined {
    if (typeof defaultPath !== 'string' || defaultPath.length > 4096) return undefined;
    return isSingleLine(defaultPath) && isAbsolute(defaultPath) ? defaultPath : undefined;
  }

  ipcMain.handle(IPC.chooseFolder, async (event, defaultPath: unknown) => {
    if (!trusted(event) || !win) return null;
    const start = dialogStart(defaultPath);
    const result = await dialog.showOpenDialog(win, {
      title: '選擇設計資料夾',
      buttonLabel: '選擇資料夾',
      properties: ['openDirectory', 'createDirectory'],
      ...(start ? { defaultPath: start } : {}),
    });
    const folder = result.canceled ? undefined : result.filePaths[0];
    if (!folder) return null;
    chosenFolders.add(folder);
    return folder;
  });
  // GitHub's pages only: the device sign-in page, creating a repository,
  // installing the app, a repository, the authorized apps. The URL comes from
  // the renderer, so it is checked here, not trusted.
  ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
    if (!trusted(event) || typeof url !== 'string' || url.length > 2048 || !URL.canParse(url)) return false;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) {
      return false;
    }
    await shell.openExternal(parsed.href);
    return true;
  });
  // Text the app composed: the sign-in code, a CLI or MCP setup snippet.
  // (The page's own clipboard access is denied with every other permission.)
  ipcMain.handle(IPC.copyText, (event, text: unknown) => {
    if (!trusted(event) || typeof text !== 'string' || text.length > 8192) return false;
    void clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(IPC.agentSetup, (event) => (trusted(event) ? agentSetup() : null));
  // The diagnostics export: the user picks where in the native dialog, Main
  // gets the report from the Engine itself (de-identified there, checked
  // against its schema again here) and writes it. The renderer only asks.
  let lastExport: string | null = null;
  ipcMain.handle(IPC.exportDiagnostics, async (event): Promise<DiagnosticsExport | null> => {
    if (!trusted(event) || !win) return null;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, '')
      .replace('T', '-');
    const chosen = await dialog.showSaveDialog(win, {
      title: '匯出診斷資訊',
      buttonLabel: '儲存',
      defaultPath: join(app.getPath('downloads'), `draft-tide-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' };
    const envelope = await engine.invoke('diagnostics.report', {});
    const report = DiagnosticsReport.safeParse(envelope.data);
    if (!envelope.ok || !report.success) {
      return {
        status: 'failed',
        error:
          envelope.error ?? toErrorInfo(new DtError('INTERNAL_ERROR', 'the report was not what Draft Tide expects')),
      };
    }
    try {
      await writeFile(chosen.filePath, `${JSON.stringify(report.data, null, 2)}\n`, { mode: 0o600 });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      return {
        status: 'failed',
        error: toErrorInfo(
          new DtError(
            code === 'ENOSPC' ? 'INSUFFICIENT_DISK_SPACE' : 'STORAGE_IO_FAILED',
            'the report could not be saved there',
            code ? { errno: code } : {},
          ),
        ),
      };
    }
    lastExport = chosen.filePath;
    return { status: 'saved', fileName: basename(chosen.filePath), report: report.data };
  });
  ipcMain.handle(IPC.revealDiagnostics, (event) => {
    if (!trusted(event) || lastExport === null || !existsSync(lastExport)) return false;
    shell.showItemInFolder(lastExport);
    return true;
  });
  ipcMain.handle(IPC.connectionState, (event) => (trusted(event) ? engine.state : null));
  ipcMain.handle(IPC.reconnect, async (event) => {
    if (!trusted(event)) return null;
    await engine.connect().catch(() => undefined);
    return engine.state;
  });

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      attendedAt = 0;
      attend();
      // The Engine may have started again meanwhile: don't wait for the
      // reconnect backoff.
      engine.connect().catch(() => undefined);
    });
    // Every web contents: no new windows, no navigation away from the GUI, no
    // webviews, no permissions.
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (e, url) => {
        if (!isGuiUrl(url)) e.preventDefault();
      });
      contents.on('will-attach-webview', (e) => e.preventDefault());
    });
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => engine.stop());
    void app.whenReady().then(start);
  }
}

function serveGui(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'gui') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = resolve(GUI_DIR, rel);
    if (!file.startsWith(GUI_DIR + sep) || !existsSync(file)) {
      return new Response('not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('content-security-policy', GUI_CSP);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

async function start(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (!BUILD.guiDevUrl) serveGui();

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    title: 'Draft Tide',
    backgroundColor: '#f4f3ef',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: BUILD.mode !== 'release',
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  // Start the Engine while the GUI loads; the GUI reads the state when ready.
  engine.connect().catch(() => undefined);
  await win.loadURL(BUILD.guiDevUrl ?? 'app://gui/index.html');
}
