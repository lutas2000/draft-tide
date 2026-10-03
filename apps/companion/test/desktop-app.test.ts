// Opening the app for a request (M1 plan §5, §9.1). Which app the Engine
// starts (only its own, in a release), how, and what the tool channel hears:
// the app comes forward when it is open, starts when it isn't, and the
// request waits for the user either way.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_LAUNCH_ENV, EXIT_CODES, type EngineEvent } from '@draft-tide/contracts';
import { DATA_DIR_ENV, defaultDataDir, packagedLayout } from '@draft-tide/engine-client';
import { afterAll, describe, expect, it } from 'vitest';
import type { BuildInfo } from '../src/build-info.ts';
import { OPENING_MS, appStart, createDesktopApp, desktopAppStarter } from '../src/engine/desktop-app.ts';
import { CLI_SOURCE, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

const NO_GITHUB = { clientId: null, appSlug: null };
const DEVELOPMENT: BuildInfo = {
  mode: 'development',
  appVersion: '0',
  desktopRequirement: null,
  github: NO_GITHUB,
  previewRenderer: null,
};
const RELEASE: BuildInfo = { ...DEVELOPMENT, mode: 'release', appVersion: '1', desktopRequirement: 'x' };

const scratch = mkdtempSync(join(tmpdir(), 'dt-app-'));
afterAll(async () => {
  await cleanupDataDirs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('which app the Engine opens', () => {
  it('opens the app bundle it ships in, in a release on macOS, and nothing else', () => {
    const bundle = join(scratch, 'Draft Tide.app');
    const layout = packagedLayout(join(bundle, 'Contents', 'Resources'), 'darwin');
    const engine = { sea: true, execPath: layout.engine, platform: 'darwin' as const };
    const env = { [APP_LAUNCH_ENV]: JSON.stringify({ command: '/bin/evil', args: [] }) };
    // Not a packaged app (no Info.plist): nothing to open.
    expect(desktopAppStarter(RELEASE, env, engine)).toBeNull();
    mkdirSync(join(bundle, 'Contents'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '');
    expect(desktopAppStarter(RELEASE, env, engine)).toEqual({ kind: 'bundle', bundle });
    // Not the packaged Engine, or not macOS.
    expect(desktopAppStarter(RELEASE, env, { ...engine, sea: false })).toBeNull();
    expect(desktopAppStarter(RELEASE, env, { ...engine, platform: 'linux' })).toBeNull();
  });

  it('opens it with open -n, passing a data directory other than the default', () => {
    const starter = { kind: 'bundle' as const, bundle: '/Applications/Draft Tide.app' };
    const usual = appStart(starter, defaultDataDir('darwin'), 'darwin');
    expect(usual.command).toBe('/usr/bin/open');
    expect(usual.args).toEqual(['-n', '-a', '/Applications/Draft Tide.app']);
    const other = appStart(starter, '/tmp/other store', 'darwin');
    expect(other.args).toEqual([
      '-n',
      '-a',
      '/Applications/Draft Tide.app',
      '--env',
      `${DATA_DIR_ENV}=/tmp/other store`,
    ]);
    // Built from scratch: the OS basics and the data directory, nothing else.
    expect(
      Object.keys(other.env).every((k) =>
        [DATA_DIR_ENV, 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL'].includes(k),
      ),
    ).toBe(true);
  });

  it('takes a development launch from the environment, checked strictly', () => {
    const launch = { command: process.execPath, args: ['/x/main.mjs'] };
    expect(desktopAppStarter(DEVELOPMENT, { [APP_LAUNCH_ENV]: JSON.stringify(launch) })).toEqual({
      kind: 'command',
      launch,
    });
    for (const bad of ['{', '{"command":"node","args":[]}', '{"command":"/n","args":[],"x":1}']) {
      expect(desktopAppStarter(DEVELOPMENT, { [APP_LAUNCH_ENV]: bad }), bad).toBeNull();
    }
    expect(desktopAppStarter(DEVELOPMENT, {})).toBeNull();
  });

  it('says shown while the app is connected, starts it once, then says opening for a while', () => {
    let sessions = 0;
    let now = 1_000;
    const logs: string[] = [];
    const app = createDesktopApp({
      starter: { kind: 'command', launch: { command: process.execPath, args: ['-e', ''] } },
      dataDir: scratch,
      desktopSessions: () => sessions,
      log: (m) => logs.push(m),
      now: () => now,
    });
    expect(app.attend()).toBe('opening');
    expect(app.attend()).toBe('opening');
    expect(logs.filter((l) => l.startsWith('opening the app'))).toHaveLength(1);
    sessions = 1;
    expect(app.attend()).toBe('shown');
    sessions = 0;
    now += OPENING_MS;
    expect(app.attend()).toBe('opening');
    expect(logs.filter((l) => l.startsWith('opening the app'))).toHaveLength(2);
    const none = createDesktopApp({ starter: null, dataDir: scratch, desktopSessions: () => 0, log: () => undefined });
    expect(none.attend()).toBe('unavailable');
  });
});

describe('a request on a real Engine', () => {
  // A stand-in for the app: records each start with its data directory and
  // the names of the variables it got.
  const marker = join(scratch, 'starts.jsonl');
  const fakeApp = join(scratch, 'fake-app.mjs');
  writeFileSync(
    fakeApp,
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify({ dataDir: process.env.${DATA_DIR_ENV}, keys: Object.keys(process.env) }) + '\\n');
`,
  );
  const starts = () => {
    try {
      return readFileSync(marker, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { dataDir: string; keys: string[] });
    } catch {
      return [];
    }
  };

  function cliRequest(dataDir: string, root: string) {
    const r = spawnSync(
      process.execPath,
      [CLI_SOURCE, '--data-dir', dataDir, '--json', 'init', 'request', '--root', root],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(r.status).toBe(EXIT_CODES.failed);
    return JSON.parse(r.stdout) as { error: { code: string; details: Record<string, unknown>; message: string } };
  }

  it('opens the app when it is closed, brings it forward when it is open', async () => {
    const dataDir = tempDataDir();
    const desktop = await connectTo(dataDir, 'desktop', 20_000, {
      [APP_LAUNCH_ENV]: JSON.stringify({ command: process.execPath, args: [fakeApp, marker] }),
    });
    await desktop.call('agentAccess.set', { enabled: true });
    const events: EngineEvent[] = [];
    desktop.onEvent((e) => events.push(e));

    // Open: the window comes forward on the event; nothing is started.
    const shown = cliRequest(dataDir, '/tmp/shown-folder');
    expect(shown.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', details: { app: 'shown' } });
    const shownId = shown.error.details['operationId'];
    await expect.poll(() => events.some((e) => e.name === 'request.waiting' && e.operationId === shownId)).toBe(true);
    expect(starts()).toHaveLength(0);

    // Closed: the Engine starts the app, once, for this data store.
    desktop.close();
    await new Promise((r) => setTimeout(r, 200));
    const opening = cliRequest(dataDir, '/tmp/opening-folder');
    expect(opening.error.details['app']).toBe('opening');
    expect(opening.error.message).toMatch(/opening with the request/);
    await expect.poll(() => starts().length).toBe(1);
    const [start] = starts();
    expect(start?.dataDir).toBe(dataDir);
    expect(start?.keys).not.toContain('NODE_OPTIONS');
    expect(start?.keys).not.toContain('DRAFT_TIDE_GIT');
    expect(cliRequest(dataDir, '/tmp/again').error.details['app']).toBe('opening');
    await new Promise((r) => setTimeout(r, 300));
    expect(starts()).toHaveLength(1);
    // The requests wait for the user all the same.
    const again = await connectTo(dataDir, 'desktop');
    expect((await again.call('operation.list', {})).requests).toHaveLength(3);
    again.close();
  });

  it('says the user has to open the app when this Engine has none to open', async () => {
    const dataDir = tempDataDir();
    const desktop = await connectTo(dataDir, 'desktop', 20_000);
    await desktop.call('agentAccess.set', { enabled: true });
    desktop.close();
    await new Promise((r) => setTimeout(r, 200));
    const r = cliRequest(dataDir, '/tmp/nowhere');
    expect(r.error.details['app']).toBe('unavailable');
    const human = spawnSync(
      process.execPath,
      [CLI_SOURCE, '--data-dir', dataDir, 'init', 'request', '--root', '/tmp/x'],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(human.stderr).toMatch(/Open the Draft Tide app to answer it/);
  });
});
