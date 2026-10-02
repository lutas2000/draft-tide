import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_HOST_ENV,
  TEST_GITHUB_ENV,
  errorEnvelope,
  okEnvelope,
  previewRendererId,
  type Envelope,
  type PreviewHostLaunch,
} from '@draft-tide/contracts';
import { connectEngine, type EngineConnection, type EngineLaunch } from '@draft-tide/engine-client';
import type { BridgeEvent, ConnectionState } from '../shared/bridge.ts';
import { BUILD } from './build-info.ts';

// Development and e2e builds: the Engine's Preview Host is this same
// Electron and Main bundle, started with --dt-preview-host. (Main is one
// bundle, so this module's URL is the bundle's.) Release builds: M1-09 gives
// the Preview Host its place, and its own signing identity, in the app bundle.
function previewHost(): PreviewHostLaunch {
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url)],
    renderer: previewRendererId(process.versions.electron, process.versions.chrome),
  };
}

function launch(): EngineLaunch {
  if (BUILD.companion) {
    // Development and e2e builds may name the Git to run and a test GitHub
    // (the E2E); release builds use only the bundled Git and github.com.
    const git = process.env['DRAFT_TIDE_GIT'];
    const testGitHub = process.env[TEST_GITHUB_ENV];
    return {
      nodePath: BUILD.companion.nodePath,
      engineEntry: BUILD.companion.engineEntry,
      env: {
        ...(git ? { DRAFT_TIDE_GIT: git } : {}),
        ...(testGitHub ? { [TEST_GITHUB_ENV]: testGitHub } : {}),
        [PREVIEW_HOST_ENV]: JSON.stringify(previewHost()),
      },
    };
  }
  // Packaged layout (M1-09): the bundled Node and the companion bundle sit in
  // the app's resources, outside the asar.
  return {
    nodePath: join(process.resourcesPath, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    engineEntry: join(process.resourcesPath, 'companion', 'engine.mjs'),
  };
}

// Main's desktop-channel session with the Engine. Starts the Engine when
// needed and reconnects (with backoff) if it goes away.
export class DesktopEngine {
  #conn: EngineConnection | null = null;
  #state: ConnectionState = { status: 'connecting' };
  #connecting: Promise<EngineConnection> | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #retryDelay = 1_000;
  #stopped = false;
  readonly #onState: (state: ConnectionState) => void;
  readonly #onEvent: (event: BridgeEvent) => void;

  constructor(handlers: { onState: (s: ConnectionState) => void; onEvent: (e: BridgeEvent) => void }) {
    this.#onState = handlers.onState;
    this.#onEvent = handlers.onEvent;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    this.#onState(state);
  }

  connect(): Promise<EngineConnection> {
    if (this.#conn && !this.#conn.closed) return Promise.resolve(this.#conn);
    if (this.#connecting) return this.#connecting;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#setState({ status: 'connecting' });
    this.#connecting = connectEngine({
      channel: 'desktop',
      client: { name: 'draft-tide-desktop', version: BUILD.appVersion },
      launch: launch(),
    })
      .then((conn) => {
        this.#conn = conn;
        this.#retryDelay = 1_000;
        conn.onEvent((event, info) => this.#onEvent({ event, gap: info.gap }));
        conn.onClose(() => {
          this.#conn = null;
          if (this.#stopped) return;
          this.#setState({ status: 'unavailable', message: 'the Engine connection closed' });
          this.#scheduleRetry();
        });
        this.#setState({ status: 'connected', instanceId: conn.instanceId });
        return conn;
      })
      .catch((e: unknown) => {
        this.#setState({ status: 'unavailable', message: e instanceof Error ? e.message : String(e) });
        this.#scheduleRetry();
        throw e;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(this.#retryDelay * 2, 30_000);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.connect().catch(() => undefined);
    }, delay);
  }

  async invoke(op: string, payload: unknown): Promise<Envelope<unknown>> {
    try {
      const conn = await this.connect();
      return okEnvelope(await conn.callRaw(op, payload));
    } catch (e) {
      return errorEnvelope(e);
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#conn?.close();
  }
}
