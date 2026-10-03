// The Engine as a Node SEA (macOS): what the release Engine relies on, checked
// on real SEAs built the way release packaging builds them (ad hoc signed
// here; packaging re-signs with the Developer ID).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectEngine, runtimePaths } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEngineSea, buildNative, releaseRequirement } from '../scripts/build.ts';
import { unexpectedVariables } from '../src/engine/environment.ts';
import { COMPANION, RawClient, cleanupDataDirs, hello, readDiscovery, tempDataDir } from './helpers.ts';

afterAll(cleanupDataDirs);

describe('the release environment allowlist', () => {
  it('admits the OS basics and the release variables only', () => {
    expect(
      unexpectedVariables({
        HOME: '/h',
        TMPDIR: '/t',
        USER: 'u',
        LOGNAME: 'u',
        LANG: 'C',
        LC_ALL: 'C',
        __CF_USER_TEXT_ENCODING: '0x1F5:0:0',
        DRAFT_TIDE_DATA_DIR: '/d',
        DRAFT_TIDE_ENGINE_IDLE_MS: '1',
      }),
    ).toEqual([]);
  });

  it('names everything else, development knobs included', () => {
    expect(
      unexpectedVariables({
        HOME: '/h',
        NODE_OPTIONS: '-r x',
        NODE_EXTRA_CA_CERTS: '/ca',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_USE_ENV_PROXY: '1',
        PATH: '/usr/bin',
        DRAFT_TIDE_GIT: '/git',
        DRAFT_TIDE_PREVIEW_HOST: '{}',
        DRAFT_TIDE_TEST_GITHUB: '{}',
      }),
    ).toEqual([
      'DRAFT_TIDE_GIT',
      'DRAFT_TIDE_PREVIEW_HOST',
      'DRAFT_TIDE_TEST_GITHUB',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_USE_ENV_PROXY',
      'PATH',
    ]);
  });
});

interface Started {
  child: ChildProcess;
  stderr: () => string;
  exit: Promise<number | null>;
}

const BASE_ENV = (): Record<string, string> => ({
  HOME: process.env['HOME'] ?? '/tmp',
  TMPDIR: process.env['TMPDIR'] ?? '/tmp',
  LANG: 'en_US.UTF-8',
});

function start(exe: string, env: Record<string, string>): Started {
  const child = spawn(exe, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stderr: () => err, exit };
}

async function until(fn: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe.runIf(process.platform === 'darwin')('the Engine as a Node SEA (macOS)', () => {
  const work = mkdtempSync(join(tmpdir(), 'dt-sea-'));
  const started: Started[] = [];
  let devEngine = '';
  let releaseEngine = '';
  const requirement = releaseRequirement('app.drafttide.test', 'ABCDE12345');
  const noGitHub = { clientId: null, appSlug: null };

  beforeAll(async () => {
    buildNative();
    const nativeDir = join(COMPANION, 'dist', 'native');
    devEngine = await buildEngineSea(
      { mode: 'development', appVersion: '0.0.0-sea', desktopRequirement: null, github: noGitHub },
      join(work, 'development'),
      nativeDir,
    );
    releaseEngine = await buildEngineSea(
      { mode: 'release', appVersion: '9.9.9-sea', desktopRequirement: requirement, github: noGitHub },
      join(work, 'release'),
      nativeDir,
    );
  }, 180_000);

  afterAll(async () => {
    for (const s of started) s.child.kill('SIGTERM');
    await Promise.all(started.map((s) => s.exit));
    rmSync(work, { recursive: true, force: true });
  });

  function run(exe: string, env: Record<string, string>): Started {
    const s = start(exe, env);
    started.push(s);
    return s;
  }

  it.each(['NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'DRAFT_TIDE_GIT', 'PATH'])(
    'a release Engine refuses to start with %s in its environment',
    async (name) => {
      const dataDir = tempDataDir();
      const s = run(releaseEngine, { ...BASE_ENV(), DRAFT_TIDE_DATA_DIR: dataDir, [name]: '/dev/null' });
      expect(await s.exit).toBe(2);
      expect(s.stderr()).toContain(name);
      // It stopped before touching the data store.
      expect(existsSync(join(dataDir, 'runtime'))).toBe(false);
      expect(existsSync(join(dataDir, 'diagnostics'))).toBe(false);
    },
  );

  it('a release Engine starts in its allowlist, loads SQLite and its addons, and checks the desktop by signature', async () => {
    const dataDir = tempDataDir();
    run(releaseEngine, { ...BASE_ENV(), DRAFT_TIDE_DATA_DIR: dataDir, DRAFT_TIDE_ENGINE_IDLE_MS: '60000' });
    expect(await until(() => readDiscovery(dataDir) !== null)).toBe(true);
    const conn = await connectEngine({ channel: 'cli', dataDir, client: { name: 'test', version: '0' } });
    expect(await conn.call('engine.info', {})).toMatchObject({
      appVersion: '9.9.9-sea',
      desktopIdentity: 'code-signature',
      runtime: { node: process.version },
    });
    conn.close();
    // This test process isn't the signed app: no desktop session.
    const raw = await RawClient.open(runtimePaths(dataDir).socket);
    raw.send(hello('desktop'));
    expect(await raw.next()).toMatchObject({ type: 'rejected', error: { code: 'UNAUTHENTICATED' } });
    raw.socket.end();
  });

  it('a SEA runs no code from NODE_OPTIONS and opens no inspector on SIGUSR1', async () => {
    const dataDir = tempDataDir();
    const marker = join(work, 'node-options-ran');
    const evil = join(work, 'evil.cjs');
    writeFileSync(evil, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    // A development SEA: the release one would refuse NODE_OPTIONS outright.
    const s = run(devEngine, {
      ...BASE_ENV(),
      DRAFT_TIDE_DATA_DIR: dataDir,
      DRAFT_TIDE_ENGINE_IDLE_MS: '60000',
      NODE_OPTIONS: `--require ${evil}`,
    });
    expect(await until(() => readDiscovery(dataDir) !== null)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    process.kill(s.child.pid ?? 0, 'SIGUSR1');
    await new Promise((r) => setTimeout(r, 750));
    expect(s.stderr()).not.toContain('Debugger listening');
    expect(s.child.exitCode).toBeNull();
  });
});
