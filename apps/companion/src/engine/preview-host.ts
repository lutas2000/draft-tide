// The preview supervisor (TECH_STACK §10.1): starts the app binary in Preview
// Host mode and drives it over one inherited pipe. The host gets a job and,
// for each file its page asks for, exactly what core's file source answers;
// it has no data directory, database, Git, tokens or Engine channel. Its
// environment is built from scratch, and its scratch directory (user data,
// caches) is removed when it exits.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  DtError,
  HostToEngine,
  PREVIEW_HOST_ENV,
  PREVIEW_HOST_FLAG,
  PREVIEW_HOST_PROTOCOL,
  PREVIEW_HOST_SCRATCH_ENV,
  PreviewHostLaunch,
  previewRendererId,
  type EngineToHost,
  type HostDone,
  type HostReady,
  type PreviewImageKind,
  type ProjectId,
} from '@draft-tide/contracts';
import {
  previewFailed,
  type CapturedImage,
  type PreviewFileSource,
  type PreviewRenderer,
  type RenderJob,
  type RenderOutput,
} from '@draft-tide/core';
import { HostFrameDecoder, encodeHostFrame } from '@draft-tide/engine-client';
import type { BuildInfo } from '../build-info.ts';

// How long a host may take to start and say it is ready.
const READY_TIMEOUT_MS = 15_000;
// Beyond the job's own timeout (which the host enforces and reports), before
// the host is killed.
const KILL_GRACE_MS = 5_000;
// An idle host exits after this long; a host serves this many jobs at most.
const IDLE_MS = 10_000;
const JOBS_PER_HOST = 20;
const STDERR_TAIL = 8 * 1024;

// Release builds have no Preview Host until M1-09 places it in the app bundle
// (and gives it its own signing identity). Development and e2e builds take it
// from the launcher.
export function previewHostLaunch(build: BuildInfo, env = process.env): PreviewHostLaunch | null {
  if (build.mode === 'release') return null;
  const raw = env[PREVIEW_HOST_ENV];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const launch = PreviewHostLaunch.safeParse(parsed);
  return launch.success && isAbsolute(launch.data.command) ? launch.data : null;
}

function hostEnvironment(scratch: string, timezone: string): Record<string, string> {
  const env: Record<string, string> = { [PREVIEW_HOST_SCRATCH_ENV]: scratch };
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
    if (root) env['SystemRoot'] = root;
    Object.assign(env, { USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, TEMP: scratch, TMP: scratch });
  } else {
    Object.assign(env, { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, TZ: timezone, LANG: 'en_US.UTF-8' });
  }
  return env;
}

interface ActiveJob {
  job: RenderJob;
  files: PreviewFileSource;
  images: Partial<Record<PreviewImageKind, CapturedImage>>;
  resolve: (done: HostDone) => void;
}

class HostProcess {
  readonly projectId: ProjectId;
  readonly ready: Promise<HostReady>;
  jobs = 0;
  exited = false;
  readonly #child: ChildProcess;
  readonly #pipe: Duplex;
  readonly #scratch: string;
  readonly #log: (msg: string) => void;
  #stderr = '';
  #active: ActiveJob | null = null;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(launch: PreviewHostLaunch, projectId: ProjectId, timezone: string, log: (msg: string) => void) {
    this.projectId = projectId;
    this.#log = log;
    this.#scratch = mkdtempSync(join(tmpdir(), 'dt-preview-'));
    this.#child = spawn(launch.command, [...launch.args, PREVIEW_HOST_FLAG], {
      // On Windows an extra pipe reaches the child as a synchronous handle,
      // and Windows serializes synchronous I/O on one handle: the host's
      // pending read would block its first write (`ready`) for good. An
      // overlapped handle lets both run.
      stdio: ['ignore', 'ignore', 'pipe', process.platform === 'win32' ? 'overlapped' : 'pipe'],
      env: hostEnvironment(this.#scratch, timezone),
      windowsHide: true,
    });
    const pipe = this.#child.stdio[3];
    if (!pipe || !('write' in pipe)) throw previewFailed('crashed', 'the Preview Host has no pipe');
    this.#pipe = pipe as Duplex;
    this.#child.stderr?.on('data', (b: Buffer) => {
      this.#stderr = (this.#stderr + b.toString('utf8')).slice(-STDERR_TAIL);
    });

    let onReady: (r: HostReady) => void = () => undefined;
    let onFail: (e: DtError) => void = () => undefined;
    this.ready = new Promise<HostReady>((resolve, reject) => {
      onReady = resolve;
      onFail = reject;
    });
    this.ready.catch(() => undefined);
    const readyTimer = setTimeout(() => {
      onFail(previewFailed('crashed', 'the Preview Host did not start in time'));
      this.kill();
    }, READY_TIMEOUT_MS);

    const decoder = new HostFrameDecoder();
    this.#pipe.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        this.#log('preview host: malformed frame; stopping it');
        return this.kill();
      }
      for (const { header, body } of frames) {
        const parsed = HostToEngine.safeParse(header);
        if (!parsed.success) {
          this.#log('preview host: unexpected message; stopping it');
          return this.kill();
        }
        const msg = parsed.data;
        if (msg.type === 'ready') {
          clearTimeout(readyTimer);
          if (msg.protocol !== PREVIEW_HOST_PROTOCOL) {
            onFail(previewFailed('renderer-mismatch', 'the Preview Host speaks another protocol version'));
            return this.kill();
          }
          onReady(msg);
          continue;
        }
        const active = this.#active;
        if (!active || msg.jobId !== active.job.jobId) continue;
        if (msg.type === 'fetch') {
          void this.#serve(active, msg.requestId, msg.path);
        } else if (msg.type === 'image') {
          active.images[msg.image] = { png: new Uint8Array(body), width: msg.width, height: msg.height };
        } else {
          this.#active = null;
          active.resolve(msg);
        }
      }
    });
    this.#pipe.on('error', () => undefined);
    this.#child.on('error', (e) => {
      clearTimeout(readyTimer);
      onFail(previewFailed('crashed', `the Preview Host could not start (${e.message})`));
      this.#onExit();
    });
    this.#child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      onFail(previewFailed('crashed', 'the Preview Host stopped before it was ready'));
      if (this.#active || code !== 0) {
        this.#log(`preview host exited (${signal ?? code}): ${this.#stderr.slice(-1000).replace(/\s+/g, ' ')}`);
      }
      this.#onExit();
    });
  }

  async #serve(active: ActiveJob, requestId: number, path: string): Promise<void> {
    let header: EngineToHost;
    let body: Uint8Array | undefined;
    try {
      const file = await active.files.read(path);
      if (file.status === 'ok') {
        header = { type: 'file', jobId: active.job.jobId, requestId, status: 'ok', contentType: file.contentType };
        body = file.bytes;
      } else {
        header = { type: 'file', jobId: active.job.jobId, requestId, status: 'missing' };
      }
    } catch {
      header = { type: 'file', jobId: active.job.jobId, requestId, status: 'missing' };
    }
    if (this.#active === active) this.#send(header, body);
  }

  #send(message: EngineToHost, body?: Uint8Array): void {
    if (this.exited || this.#pipe.destroyed) return;
    this.#pipe.write(encodeHostFrame(message, body));
  }

  // One job at a time; the host must be ready.
  run(ready: HostReady, job: RenderJob, files: PreviewFileSource, signal: AbortSignal): Promise<RenderOutput> {
    if (this.exited) return Promise.reject(previewFailed('crashed', 'the Preview Host stopped before the render'));
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.jobs++;
    return new Promise<RenderOutput>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#child.off('exit', onExit);
        this.#active = null;
      };
      const fail = (e: DtError) => {
        if (settled) return;
        settle();
        reject(e);
        // Whatever the host was doing can't be trusted to stop on its own.
        this.kill();
      };
      const onAbort = () =>
        fail(signal.reason instanceof DtError ? signal.reason : previewFailed('timeout', 'the render was stopped'));
      const onExit = () => fail(previewFailed('crashed', 'the Preview Host stopped during the render'));
      const timer = setTimeout(
        () => fail(previewFailed('timeout', 'the Preview Host did not finish in time')),
        job.timeoutMs + KILL_GRACE_MS,
      );
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.#child.once('exit', onExit);

      const active: ActiveJob = {
        job,
        files,
        images: {},
        resolve: (done) => {
          if (settled) return;
          settle();
          this.#scheduleIdle();
          if (done.outcome !== 'captured') {
            return reject(
              previewFailed(done.outcome, done.message ?? `the page could not be captured (${done.outcome})`),
            );
          }
          const { full, thumbnail } = active.images;
          if (!full || !thumbnail) return reject(previewFailed('invalid-output', 'the Preview Host sent no image'));
          resolve({
            full,
            thumbnail,
            blocked: done.blocked,
            environment: {
              renderer: previewRendererId(ready.electron, ready.chromium),
              electron: ready.electron,
              chromium: ready.chromium,
              platform: ready.platform,
              osRelease: ready.osRelease,
            },
          });
        },
      };
      this.#active = active;
      this.#send({
        type: 'job',
        jobId: job.jobId,
        subject: job.subject,
        settings: job.settings,
        output: job.output,
        thumbnail: job.thumbnail,
        timeoutMs: job.timeoutMs,
      });
    });
  }

  #scheduleIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.#idleTimer.unref();
  }

  // Asks the host to exit, and makes sure it does.
  stop(): void {
    if (this.exited) return;
    this.#send({ type: 'exit' });
    setTimeout(() => this.kill(), 2_000).unref();
  }

  kill(): void {
    if (this.exited) return;
    this.#child.kill('SIGKILL');
  }

  #onExit(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#pipe.destroy();
    rmSync(this.#scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // On Engine shutdown: no waiting.
  destroy(): void {
    this.kill();
    this.#onExit();
  }
}

export interface PreviewSupervisor extends PreviewRenderer {
  stop(): void;
}

export function createPreviewSupervisor(options: {
  launch: PreviewHostLaunch | null;
  timezone: string;
  log: (msg: string) => void;
}): PreviewSupervisor {
  const { launch, timezone, log } = options;
  let host: HostProcess | null = null;

  async function hostFor(projectId: ProjectId): Promise<{ host: HostProcess; ready: HostReady }> {
    if (!launch) throw previewFailed('no-renderer', 'this Draft Tide Engine has no Preview Host');
    // One project per host process, and a fresh one now and then.
    if (host && (host.exited || host.projectId !== projectId || host.jobs >= JOBS_PER_HOST)) {
      host.stop();
      host = null;
    }
    if (!host) host = new HostProcess(launch, projectId, timezone, log);
    const current = host;
    const ready = await current.ready;
    if (previewRendererId(ready.electron, ready.chromium) !== launch.renderer) {
      current.stop();
      if (host === current) host = null;
      throw previewFailed('renderer-mismatch', 'the Preview Host is not the renderer this Engine was told about');
    }
    return { host: current, ready };
  }

  return {
    rendererId: launch?.renderer ?? null,
    async render(job, files, signal) {
      const { host: h, ready } = await hostFor(job.projectId);
      return h.run(ready, job, files, signal);
    },
    stop() {
      host?.destroy();
      host = null;
    },
  };
}
