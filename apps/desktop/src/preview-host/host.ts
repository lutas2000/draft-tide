// The Preview Host (M1 plan §8, TECH_STACK §10): the app binary started by
// the Engine with --dt-preview-host. It renders one job at a time offscreen
// and sends back two PNGs. Everything it knows comes over its one pipe (fd 3)
// from the Engine: the job, and each file the page asks for. It has no window
// on screen, no preload, no Node in the renderer, no data directory, no
// database, Git, tokens or Engine channel, and every network path is closed
// (requests cancelled, DNS mapped to nowhere, WebRTC forced through a dead
// proxy). The design's pages run their scripts in a sandboxed renderer of an
// in-memory session that lives for one job.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BrowserWindow, Menu, app, protocol, session, type NativeImage, type Session } from 'electron';
import {
  EngineToHost,
  PREVIEW_HOST_PROTOCOL,
  PREVIEW_HOST_SCRATCH_ENV,
  PREVIEW_SETTLE_MS,
  type HostDone,
  type HostFile,
  type HostJob,
  type HostToEngine,
  type PreviewBlockedKind,
} from '@draft-tide/contracts';
import { HostFrameDecoder, encodeHostFrame } from '@draft-tide/engine-client';

const SCHEME = 'dt-preview';
// The network is closed below the page (request filter, DNS, proxy), so the
// page's CSP doesn't restrict where it loads from: a request it makes then
// reaches the filter and is recorded as blocked, instead of vanishing in a CSP
// check. It only closes what has no place in a preview.
const PAGE_CSP = "object-src 'none'; base-uri 'self'; form-action 'none'";
const IMAGE_PAGE_CSP = "default-src 'none'; img-src dt-preview:; style-src 'unsafe-inline'";
// CSS animations and transitions jump to their end state (user-origin
// !important wins over the page's own).
const STILL_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}`;
const MAX_BLOCKED_ENTRIES = 100;

function entryUrl(path: string): string {
  return `${SCHEME}://job/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function imagePage(path: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{background:#fff conic-gradient(#e9e9e9 25%,#fff 0 50%,#e9e9e9 0 75%,#fff 0) 0 0/16px 16px}
img{display:block;width:100vw;height:100vh}
</style><img alt="" src="${entryUrl(path)}">`;
}

class Blocked {
  count = 0;
  entries: { kind: PreviewBlockedKind; target: string }[] = [];
  add(kind: PreviewBlockedKind, target: string): void {
    this.count++;
    if (this.entries.length < MAX_BLOCKED_ENTRIES) this.entries.push({ kind, target: target.slice(0, 2048) });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function runPreviewHost(): void {
  const scratch = process.env[PREVIEW_HOST_SCRATCH_ENV];
  if (!scratch || !isAbsolute(scratch)) {
    process.stderr.write('Draft Tide Preview Host: started without its scratch directory; exiting\n');
    process.exit(2);
  }
  // Everything Chromium keeps goes to the scratch directory the Engine
  // removes afterwards; nothing touches the app's own user data.
  for (const name of ['userData', 'sessionData', 'crashDumps', 'logs'] as const) {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    app.setPath(name, dir);
  }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('lang', 'en-US');
  // No name resolves, so nothing reaches a host by name even outside the
  // request filter (prefetch, WebRTC); WebRTC may only use the (dead) proxy.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('no-pings');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
  app.dock?.hide();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  app.on('window-all-closed', () => undefined);

  let pipe: Socket;
  try {
    pipe = new Socket({ fd: 3, readable: true, writable: true });
  } catch {
    process.stderr.write('Draft Tide Preview Host: no pipe from the Engine; exiting\n');
    process.exit(2);
  }
  const send = (message: HostToEngine, body?: Uint8Array) => {
    if (!pipe.destroyed) pipe.write(encodeHostFrame(message, body));
  };
  // The Engine went away (or closed the pipe): nothing is left to do.
  pipe.on('close', () => app.exit(0));
  pipe.on('error', () => app.exit(0));

  const fetches = new Map<number, (file: { header: HostFile; body: Buffer }) => void>();
  const jobs: HostJob[] = [];
  let working = false;
  let nextRequest = 0;

  const pump = () => {
    if (working || !app.isReady()) return;
    const job = jobs.shift();
    if (!job) return;
    working = true;
    void runJob(job).finally(() => {
      working = false;
      pump();
    });
  };

  const decoder = new HostFrameDecoder();
  pipe.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      return app.exit(3);
    }
    for (const { header, body } of frames) {
      const parsed = EngineToHost.safeParse(header);
      if (!parsed.success) return app.exit(3);
      const msg = parsed.data;
      if (msg.type === 'exit') return app.exit(0);
      if (msg.type === 'job') {
        jobs.push(msg);
        pump();
      } else {
        const waiter = fetches.get(msg.requestId);
        fetches.delete(msg.requestId);
        waiter?.({ header: msg, body });
      }
    }
  });

  function fetchFromEngine(jobId: string, path: string): Promise<{ header: HostFile; body: Buffer }> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      fetches.set(requestId, resolve);
      send({ type: 'fetch', jobId, requestId, path });
    });
  }

  async function prepareSession(job: HostJob, blocked: Blocked): Promise<Session> {
    const ses = session.fromPartition(`preview-${randomUUID()}`, { cache: false });
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' });
    ses.setSpellCheckerEnabled(false);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      blocked.add('permission', permission);
      callback(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event, item) => {
      blocked.add('download', item.getURL());
      event.preventDefault();
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      const ok =
        url.startsWith(`${SCHEME}://job/`) ||
        url.startsWith(`${SCHEME}://frame/`) ||
        url.startsWith('data:') ||
        url.startsWith('blob:');
      if (!ok) blocked.add('network', url);
      callback({ cancel: !ok });
    });
    ses.protocol.handle(SCHEME, async (request) => {
      const url = new URL(request.url);
      if (url.host === 'frame' && url.pathname === '/image.html' && job.subject.kind === 'image') {
        return new Response(imagePage(job.subject.path), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': IMAGE_PAGE_CSP },
        });
      }
      if (url.host !== 'job' || (request.method !== 'GET' && request.method !== 'HEAD')) {
        return new Response(null, { status: 404 });
      }
      const file = await fetchFromEngine(job.jobId, url.pathname);
      if (file.header.status !== 'ok') return new Response(null, { status: 404 });
      return new Response(new Uint8Array(file.body), {
        headers: {
          'content-type': file.header.contentType ?? 'application/octet-stream',
          'content-security-policy': PAGE_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    });
    return ses;
  }

  async function capture(job: HostJob, blocked: Blocked, deadline: number): Promise<Omit<HostDone, 'blocked'>> {
    const ses = await prepareSession(job, blocked);
    const win = new BrowserWindow({
      show: false,
      width: job.output.width,
      height: job.output.height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        session: ses,
        // The image page is the host's own (its CSP allows no script); a
        // design's page runs its scripts when the settings say so.
        javascript: job.subject.kind === 'image' || job.settings.scripts,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: false,
        experimentalFeatures: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
        backgroundThrottling: false,
        zoomFactor: job.settings.viewport.scale,
        devTools: false,
      },
    });
    const wc = win.webContents;
    const url = job.subject.kind === 'image' ? `${SCHEME}://frame/image.html` : entryUrl(job.subject.path);
    let crashed = false;
    let timedOut = false;
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      wc.setWindowOpenHandler((details) => {
        blocked.add('popup', details.url);
        return { action: 'deny' };
      });
      // The page stays where it was loaded; frames may load the version's
      // own pages (and blank or srcdoc documents).
      wc.on('will-navigate', (event, target) => {
        event.preventDefault();
        blocked.add('navigation', target);
      });
      wc.on('will-frame-navigate', (details) => {
        if (details.isMainFrame) return;
        const target = details.url;
        if (target.startsWith(`${SCHEME}://job/`) || target === 'about:blank' || target === 'about:srcdoc') return;
        details.preventDefault();
        blocked.add('navigation', target);
      });
      wc.on('will-attach-webview', (event) => event.preventDefault());
      wc.on('render-process-gone', () => {
        crashed = true;
      });
      wc.on('dom-ready', () => {
        void wc.insertCSS(STILL_CSS, { cssOrigin: 'user' }).catch(() => undefined);
      });

      const remaining = () => Math.max(0, deadline - Date.now());
      const timeout = <T>(p: Promise<T>): Promise<T | 'timeout'> =>
        Promise.race([
          p,
          sleep(remaining()).then(() => {
            timedOut = true;
            return 'timeout' as const;
          }),
        ]);

      const loaded = await timeout(
        wc.loadURL(url).then(
          () => 'ok' as const,
          (e: unknown) => (e instanceof Error ? e.message : 'load failed'),
        ),
      );
      if (loaded === 'timeout') return { type: 'done', jobId: job.jobId, outcome: 'timeout' };
      if (loaded !== 'ok' || crashed) {
        return { type: 'done', jobId: job.jobId, outcome: 'load-failed', message: String(loaded).slice(0, 500) };
      }
      // Web fonts, two frames, then a short settle for scripts that render
      // late. Run in an isolated world: the page can't redefine what this
      // calls. It may still never resolve; the deadline decides.
      if (job.subject.kind === 'image' || job.settings.scripts) {
        const settled: unknown = await timeout(
          wc.executeJavaScriptInIsolatedWorld(1000, [
            {
              code: 'document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))',
            },
          ]),
        );
        if (settled === 'timeout') return { type: 'done', jobId: job.jobId, outcome: 'timeout' };
      }
      if (job.subject.kind === 'image') {
        const decoded: unknown = await wc.executeJavaScriptInIsolatedWorld(1000, [
          { code: 'document.images[0] ? document.images[0].complete && document.images[0].naturalWidth > 0 : false' },
        ]);
        if (decoded !== true) {
          return { type: 'done', jobId: job.jobId, outcome: 'load-failed', message: 'the image could not be decoded' };
        }
      } else {
        await sleep(Math.min(PREVIEW_SETTLE_MS, remaining()));
      }
      const image = await timeout(wc.capturePage());
      if (image === 'timeout') return { type: 'done', jobId: job.jobId, outcome: 'timeout' };
      if (crashed || image.isEmpty()) {
        return { type: 'done', jobId: job.jobId, outcome: 'capture-failed', message: 'nothing was painted' };
      }
      const full = exactly(image, job.output);
      const thumbnail = full.resize({ ...job.thumbnail, quality: 'best' });
      send({ type: 'image', jobId: job.jobId, image: 'full', ...job.output }, full.toPNG());
      send({ type: 'image', jobId: job.jobId, image: 'thumbnail', ...job.thumbnail }, thumbnail.toPNG());
      return { type: 'done', jobId: job.jobId, outcome: 'captured' };
    } finally {
      // A page stuck in a loop never stops on its own.
      if (timedOut && !crashed && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
      win.destroy();
      void ses.clearStorageData().catch(() => undefined);
    }
  }

  async function runJob(job: HostJob): Promise<void> {
    const blocked = new Blocked();
    const deadline = Date.now() + job.timeoutMs;
    let done: Omit<HostDone, 'blocked'>;
    try {
      done = await capture(job, blocked, deadline);
    } catch (e) {
      done = {
        type: 'done',
        jobId: job.jobId,
        outcome: 'capture-failed',
        message: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      };
    }
    for (const [id, waiter] of fetches) {
      fetches.delete(id);
      waiter({ header: { type: 'file', jobId: job.jobId, requestId: id, status: 'missing' }, body: Buffer.alloc(0) });
    }
    send({ ...done, blocked: { count: blocked.count, entries: blocked.entries } });
  }

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    send({
      type: 'ready',
      protocol: PREVIEW_HOST_PROTOCOL,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      platform: process.platform,
      osRelease: release().slice(0, 64),
    });
    pump();
  });
}

// The capture at exactly the size the Engine expects (a display's scale
// factor could make it larger).
function exactly(image: NativeImage, size: { width: number; height: number }): NativeImage {
  const got = image.getSize();
  return got.width === size.width && got.height === size.height
    ? image
    : image.resize({ width: size.width, height: size.height, quality: 'best' });
}
