// Checks a signed app before it ships (M1 plan §13.5, the signing items):
// - static: every Mach-O is team-signed with hardened runtime and a secure
//   timestamp and carries none of the forbidden entitlements; the payload has
//   its own identifiers; only the app satisfies the desktop requirement; the
//   Engine's designated requirement is what its keychain item will trust; the
//   Engine carries the desktop requirement compiled in; the fuses are set.
// - runtime: the signed Engine refuses an unexpected environment, the
//   packaged CLI on the packaged Node starts it and gets engine.info, the
//   bundled Git runs with its https helper, and the Preview Host renders a
//   page under the Engine's own supervisor while failing the desktop
//   requirement (the app's executable refuses to render).
// Gatekeeper's verdict comes after notarization (package.ts).
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import {
  PREVIEW_ANIMATIONS,
  PREVIEW_HOST_FLAG,
  PREVIEW_LOCALE,
  PREVIEW_THUMBNAIL,
  PREVIEW_VIEWPORT,
  PREVIEW_WAIT,
  ProjectId,
} from '@draft-tide/contracts';
import { packagedLayout } from '@draft-tide/engine-client';
import { createPreviewSupervisor, type PreviewSupervisor } from '../../../companion/src/engine/preview-host.ts';
import type { ReleaseIdentifiers } from './config.ts';
import { FORBIDDEN_ENTITLEMENTS, JIT_ENTITLEMENT, payloadSigning } from './sign.ts';

export interface Check {
  id: string;
  description: string;
  ok: boolean;
  details?: unknown;
}

export const EXPECTED_FUSES: Record<FuseV1Options, boolean> = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // The GUI uses app://, never file://.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

// codesign reports on stderr; this returns both streams and the status.
function codesign(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    return readSync(fd, buf, 0, 4, 0) === 4 && MACHO_MAGIC.has(buf.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

export function machOFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) machOFiles(p, acc);
    else if (st.isFile() && isMachO(p)) acc.push(p);
  }
  return acc;
}

export function staticChecks(
  app: string,
  options: { teamId: string; ids: ReleaseIdentifiers; desktopRequirement: string },
): Check[] {
  const checks: Check[] = [];
  const { teamId, ids } = options;
  const resources = join(app, 'Contents', 'Resources');
  const layout = packagedLayout(resources);

  const deep = codesign(['--verify', '--deep', '--strict', '--verbose=2', app]);
  checks.push({
    id: 'S1',
    description: 'the bundle passes codesign --verify --deep --strict',
    ok: deep.ok,
    details: deep.out.slice(-400),
  });

  const files = machOFiles(app);
  const problems: { file: string; problem: string }[] = [];
  for (const file of files) {
    const rel = relative(app, file);
    const d = codesign(['-d', '--verbose=4', '--entitlements', '-', '--xml', file]);
    if (!d.ok) {
      problems.push({ file: rel, problem: 'not signed' });
      continue;
    }
    if (!d.out.includes(`TeamIdentifier=${teamId}`)) problems.push({ file: rel, problem: 'not signed by the team' });
    if (!/^Authority=Developer ID Application: /m.test(d.out))
      problems.push({ file: rel, problem: 'not a Developer ID signature' });
    if (!/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(d.out))
      problems.push({ file: rel, problem: 'no hardened runtime' });
    if (!/^Timestamp=/m.test(d.out)) problems.push({ file: rel, problem: 'no secure timestamp' });
    for (const e of FORBIDDEN_ENTITLEMENTS) if (d.out.includes(e)) problems.push({ file: rel, problem: `has ${e}` });
  }
  checks.push({
    id: 'S2',
    description: `every Mach-O (${files.length}) is Developer ID-signed by ${teamId} with hardened runtime and a secure timestamp, and none carries get-task-allow, dyld variables or disable-library-validation`,
    ok: files.length > 0 && problems.length === 0,
    details: problems,
  });

  const wrongIds: { file: string; identifier: string | null; expected: string }[] = [];
  const identifierOf = (file: string) => /^Identifier=(.+)$/m.exec(codesign(['-dv', file]).out)?.[1] ?? null;
  const appIdentifier = identifierOf(app);
  if (appIdentifier !== ids.app) wrongIds.push({ file: '.', identifier: appIdentifier, expected: ids.app });
  const contents = join(app, 'Contents');
  for (const [rel, want] of payloadSigning(ids)) {
    const identifier = existsSync(join(contents, rel)) ? identifierOf(join(contents, rel)) : null;
    if (identifier !== want.identifier) wrongIds.push({ file: rel, identifier, expected: want.identifier });
    const ents = codesign(['-d', '--entitlements', '-', '--xml', join(contents, rel)]).out;
    if (ents.includes(JIT_ENTITLEMENT) !== want.jit)
      wrongIds.push({ file: rel, identifier: `jit=${!want.jit}`, expected: `jit=${want.jit}` });
  }
  checks.push({
    id: 'S3',
    description:
      'the app, the Preview Host, the companion Node, the Engine, its addons and Git have their own identifiers; of these only the Preview Host, the Node and the Engine get JIT',
    ok: wrongIds.length === 0,
    details: wrongIds,
  });

  const req = `-R=${options.desktopRequirement}`;
  const appPasses = codesign(['--verify', req, app]).ok;
  const helpers = files.filter((f) => relative(app, f).includes('Helper'));
  const passing = [layout.previewHost, layout.node, layout.engine, ...helpers]
    .filter((f) => codesign(['--verify', req, f]).ok)
    .map((f) => relative(app, f));
  checks.push({
    id: 'S4',
    description:
      'the app satisfies the desktop requirement; the Preview Host, the companion Node, the Engine and every helper fail it',
    ok: appPasses && passing.length === 0,
    details: { appPasses, passing },
  });

  const dr = codesign(['-d', '-r-', layout.engine]).out;
  const designated = /designated => (.+)$/m.exec(dr)?.[1] ?? '';
  const drOk =
    designated.includes(`identifier "${ids.engine}"`) &&
    designated.includes('anchor apple generic') &&
    designated.includes('certificate 1[field.1.2.840.113635.100.6.2.6]') &&
    designated.includes('certificate leaf[field.1.2.840.113635.100.6.1.13]') &&
    new RegExp(`certificate leaf\\[subject\\.OU\\] = "?${teamId}"?`).test(designated);
  checks.push({
    id: 'S5',
    description:
      "the Engine's designated requirement (what its keychain item trusts) pins its identifier, the Developer ID markers and the team",
    ok: drOk,
    details: designated,
  });

  // The BUILD object is inlined into the SEA's script as a JS literal (esbuild
  // picks the quotes). That it is a release build shows at runtime (R2).
  const engineBytes = readFileSync(layout.engine);
  const quoted = [options.desktopRequirement, JSON.stringify(options.desktopRequirement).slice(1, -1)];
  checks.push({
    id: 'S6',
    description: 'the Engine carries the desktop requirement compiled in',
    ok: quoted.some((q) => engineBytes.includes(q)),
    details: { requirement: options.desktopRequirement },
  });
  return checks;
}

export async function fuseCheck(app: string): Promise<Check> {
  const wire = await getCurrentFuseWire(app);
  const wrong: string[] = [];
  for (const [key, want] of Object.entries(EXPECTED_FUSES)) {
    const option: FuseV1Options = Number(key);
    const state = (wire as unknown as Record<number, FuseState | undefined>)[option];
    if (state !== (want ? FuseState.ENABLE : FuseState.DISABLE))
      wrong.push(`${FuseV1Options[option]}=${state === undefined ? 'missing' : FuseState[state]}`);
  }
  return {
    id: 'S7',
    description:
      'the fuses: RunAsNode, NODE_OPTIONS, inspect and file:// privileges off; ASAR integrity and asar-only on',
    ok: wrong.length === 0,
    details: wrong,
  };
}

function waitExit(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, ms);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const BASE_ENV = (): Record<string, string> => ({
  HOME: process.env['HOME'] ?? '',
  TMPDIR: process.env['TMPDIR'] ?? '/tmp',
  USER: process.env['USER'] ?? '',
  LANG: 'en_US.UTF-8',
});

export async function runtimeChecks(
  app: string,
  options: { appVersion: string; githubConfigured: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const layout = packagedLayout(join(app, 'Contents', 'Resources'));
  const dataDir = mkdtempSync(join(tmpdir(), 'dt-release-check-'));
  try {
    // R1: an unexpected variable stops the real Engine before it does anything.
    const refused = spawn(layout.engine, [], {
      env: { ...BASE_ENV(), DRAFT_TIDE_DATA_DIR: dataDir, NODE_EXTRA_CA_CERTS: '/dev/null' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    refused.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const code = await waitExit(refused, 10_000);
    checks.push({
      id: 'R1',
      description: 'the signed Engine refuses to start with NODE_EXTRA_CA_CERTS in its environment',
      ok: code === 2 && stderr.includes('NODE_EXTRA_CA_CERTS') && !existsSync(join(dataDir, 'runtime')),
      details: { code, stderr: stderr.trim() },
    });

    // R2: the packaged CLI on the packaged Node starts the packaged Engine.
    const info = spawnSync(
      layout.node,
      ['--disable-sigusr1', layout.cli, '--json', '--data-dir', dataDir, 'engine', 'info'],
      { env: { ...BASE_ENV(), DRAFT_TIDE_ENGINE_IDLE_MS: '1000' }, encoding: 'utf8', timeout: 30_000 },
    );
    let envelope: { ok?: boolean; data?: Record<string, unknown> } = {};
    try {
      envelope = JSON.parse(info.stdout) as typeof envelope;
    } catch {
      // reported below
    }
    const log = existsSync(join(dataDir, 'diagnostics', 'engine.log'))
      ? readFileSync(join(dataDir, 'diagnostics', 'engine.log'), 'utf8')
      : '';
    const logProblems = [
      ...(log.includes(`ready: release ${options.appVersion}`) ? [] : ['not ready as this release']),
      ...(log.includes('no Git available') ? ['no Git'] : []),
      ...(log.includes('desktop identity unavailable') ? ['no desktop identity check'] : []),
      ...(options.githubConfigured && log.includes('GitHub sign-in unavailable') ? ['no GitHub sign-in'] : []),
      ...(log.includes('no Preview Host') ? ['no Preview Host'] : []),
    ];
    checks.push({
      id: 'R2',
      description:
        'the packaged CLI on the packaged Node starts the signed Engine, which loads SQLite, the identity and keychain addons, the bundled Git and its Preview Host',
      ok:
        envelope.ok === true &&
        envelope.data?.['appVersion'] === options.appVersion &&
        envelope.data?.['desktopIdentity'] === 'code-signature' &&
        logProblems.length === 0,
      details: { status: info.status, stdout: info.stdout.slice(0, 600), stderr: info.stderr.slice(-400), logProblems },
    });

    // R3: the bundled Git runs, and finds its https helper through
    // GIT_EXEC_PATH (an unreachable address fails to connect instead of
    // "'remote-https' is not a git command").
    const gitEnv = {
      HOME: dataDir,
      GIT_EXEC_PATH: layout.gitExecPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const version = spawnSync(layout.git, ['--version'], { env: gitEnv, encoding: 'utf8' });
    const https = spawnSync(layout.git, ['ls-remote', 'https://127.0.0.1:9/none.git'], {
      env: gitEnv,
      encoding: 'utf8',
      timeout: 30_000,
    });
    checks.push({
      id: 'R3',
      description: 'the bundled Git runs and reaches its https helper',
      ok:
        version.stdout.trim() === 'git version 2.53.0' &&
        https.status !== 0 &&
        !https.stderr.includes('is not a git command') &&
        /connect|Connection refused/i.test(https.stderr),
      details: { version: version.stdout.trim(), https: https.stderr.trim().slice(0, 300) },
    });
  } finally {
    try {
      const d = JSON.parse(readFileSync(join(dataDir, 'runtime', 'engine.json'), 'utf8')) as { pid: number };
      process.kill(d.pid, 'SIGTERM');
    } catch {
      // not started, or already gone
    }
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dataDir, { recursive: true, force: true });
  }
  return checks;
}

type RenderJob = Parameters<PreviewSupervisor['render']>[0];
type FileSource = Parameters<PreviewSupervisor['render']>[1];

// A page whose script runs and then tries the network.
const PREVIEW_CHECK_PAGE = `<!doctype html><meta charset="utf-8"><title>check</title>
<style>body{margin:0;background:#2563eb;color:#fff;font:48px system-ui}</style>
<h1 id="h">waiting</h1>
<script>document.getElementById('h').textContent = 'script ran';
fetch('https://example.com/draft-tide-release-check').catch(() => undefined);</script>`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The Preview Host (R4, R5): the packaged executable under the Engine's own
// supervisor (apps/companion/src/engine/preview-host.ts, the code the release
// Engine runs), with the renderer compiled into the Engine. While it idles
// after the render, the running process is checked against the desktop
// requirement: a page that escaped the renderer's sandbox runs as this
// process. Then the app's executable must refuse to render, and the Preview
// Host to run without the Engine's flag.
export async function previewHostChecks(
  app: string,
  options: { renderer: string; desktopRequirement: string; previewHostId: string },
): Promise<Check[]> {
  const checks: Check[] = [];
  const layout = packagedLayout(join(app, 'Contents', 'Resources'));
  const logs: string[] = [];
  const supervisor = createPreviewSupervisor({
    launch: { command: layout.previewHost, args: [], renderer: options.renderer },
    timezone: 'UTC',
    log: (msg) => logs.push(msg),
  });
  const job: RenderJob = {
    jobId: randomUUID(),
    projectId: ProjectId.parse(randomUUID()),
    subject: { kind: 'page', path: 'index.html' },
    settings: {
      viewport: { ...PREVIEW_VIEWPORT },
      thumbnail: { ...PREVIEW_THUMBNAIL },
      locale: PREVIEW_LOCALE,
      timezone: 'UTC',
      scripts: true,
      wait: PREVIEW_WAIT,
      animations: PREVIEW_ANIMATIONS,
    },
    output: { width: PREVIEW_VIEWPORT.width, height: PREVIEW_VIEWPORT.height },
    thumbnail: { ...PREVIEW_THUMBNAIL },
    timeoutMs: 20_000,
  };
  const files: FileSource = {
    read: (path) =>
      Promise.resolve(
        path === '/index.html'
          ? { status: 'ok', contentType: 'text/html', bytes: new TextEncoder().encode(PREVIEW_CHECK_PAGE) }
          : { status: 'missing' },
      ),
  };
  try {
    const started = Date.now();
    let rendered: Record<string, unknown>;
    let renderOk = false;
    try {
      const out = await supervisor.render(job, files, new AbortController().signal);
      renderOk =
        out.environment.renderer === options.renderer &&
        out.full.width === PREVIEW_VIEWPORT.width &&
        out.full.height === PREVIEW_VIEWPORT.height &&
        out.thumbnail.width === PREVIEW_THUMBNAIL.width &&
        out.blocked.entries.some((e) => e.target.startsWith('https://example.com/'));
      rendered = {
        ms: Date.now() - started,
        renderer: out.environment.renderer,
        full: `${out.full.width}x${out.full.height}`,
        blocked: out.blocked.entries,
      };
    } catch (e) {
      rendered = { error: e instanceof Error ? e.message : String(e), log: logs.join(' / ').slice(-600) };
    }
    const pids = spawnSync(
      '/usr/bin/pgrep',
      ['-f', '--', `^${escapeRegExp(layout.previewHost)} ${PREVIEW_HOST_FLAG}`],
      {
        encoding: 'utf8',
      },
    )
      .stdout.trim()
      .split('\n')
      .filter((p) => p !== '');
    const live = pids.map((pid) => ({
      pid,
      identifier: /^Identifier=(.+)$/m.exec(codesign(['-dv', pid]).out)?.[1] ?? null,
      passesDesktop: codesign(['--verify', `-R=${options.desktopRequirement}`, pid]).ok,
    }));
    checks.push({
      id: 'R4',
      description:
        "the Preview Host renders a page under the Engine's supervisor (the renderer compiled into the Engine, the network closed), and the running host has its own identifier and fails the desktop requirement",
      ok:
        renderOk && live.length === 1 && live.every((l) => l.identifier === options.previewHostId && !l.passesDesktop),
      details: { rendered, live },
    });
  } finally {
    supervisor.stop();
  }

  // R5: each executable only in its own role.
  const scratch = mkdtempSync(join(tmpdir(), 'dt-preview-check-'));
  try {
    const env = { HOME: scratch, TMPDIR: scratch, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
    const appExe = join(app, 'Contents', 'MacOS', basename(app, '.app'));
    const appRun = spawnSync(appExe, [PREVIEW_HOST_FLAG], { env, encoding: 'utf8', timeout: 30_000 });
    const hostRun = spawnSync(layout.previewHost, [], { env, encoding: 'utf8', timeout: 30_000 });
    checks.push({
      id: 'R5',
      description: `the app's executable refuses ${PREVIEW_HOST_FLAG}, and the Preview Host refuses to start without it`,
      ok:
        appRun.status === 2 &&
        appRun.stderr.includes(`refusing ${PREVIEW_HOST_FLAG}`) &&
        hostRun.status === 2 &&
        hostRun.stderr.includes('the Preview Host runs only when the Engine starts it'),
      details: {
        app: { status: appRun.status, stderr: appRun.stderr.trim().slice(-200) },
        previewHost: { status: hostRun.status, stderr: hostRun.stderr.trim().slice(-200) },
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return checks;
}

// Gatekeeper's assessment (meaningful after notarization and stapling).
export function gatekeeper(path: string, type: 'exec' | 'open'): { ok: boolean; out: string } {
  const args = [
    '--assess',
    '--verbose=4',
    '--type',
    type,
    ...(type === 'open' ? ['--context', 'context:primary-signature'] : []),
    path,
  ];
  const r = spawnSync('/usr/sbin/spctl', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

export function printChecks(checks: Check[]): boolean {
  for (const c of checks) {
    process.stderr.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id} ${c.description}\n`);
    if (!c.ok && c.details !== undefined) process.stderr.write(`     ${JSON.stringify(c.details).slice(0, 1200)}\n`);
  }
  return checks.every((c) => c.ok);
}
