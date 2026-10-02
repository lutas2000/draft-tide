// Electron Main: the trusted shell. It owns the window, native dialogs and the
// desktop-channel session with the Engine. It never opens the database, runs
// Git or runs a writable core.
import './guard.ts';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, net, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { DtError, OPERATIONS, errorEnvelope, isOperationName, isSingleLine } from '@draft-tide/contracts';
import { IPC, type ConnectionState } from '../shared/bridge.ts';
import { BUILD } from './build-info.ts';
import { DesktopEngine } from './engine.ts';

const GUI_DIR = resolve(import.meta.dirname, '..', 'gui');
const GUI_ROOT_URL = BUILD.guiDevUrl ? `${new URL(BUILD.guiDevUrl).origin}/` : 'app://gui/';
const GUI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;
const isGuiUrl = (url: string) => url.startsWith(GUI_ROOT_URL);

const engine = new DesktopEngine({
  onState: (state: ConnectionState) => win?.webContents.send(IPC.connection, state),
  onEvent: (event) => win?.webContents.send(IPC.event, event),
});

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
const NEEDS_CHOSEN_FOLDER: ReadonlySet<string> = new Set(['project.review', 'project.bind']);

ipcMain.handle(IPC.invoke, async (event, op: unknown, payload: unknown) => {
  if (!trusted(event)) return errorEnvelope(new DtError('UNAUTHENTICATED', 'untrusted sender'));
  if (typeof op !== 'string' || !isOperationName(op) || !OPERATIONS[op].desktop) {
    return errorEnvelope(new DtError('UNKNOWN_OPERATION', `not an app operation: ${String(op).slice(0, 64)}`));
  }
  if (NEEDS_CHOSEN_FOLDER.has(op)) {
    const root = (payload as { root?: unknown } | null)?.root;
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
    if (win?.isMinimized()) win.restore();
    win?.focus();
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
