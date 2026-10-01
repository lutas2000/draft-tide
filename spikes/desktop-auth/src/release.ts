// Release-signing check: re-sign a copy of the packaged M0 app with a
// Developer ID (hardened runtime, no get-task-allow), notarize and staple it,
// then check the running app and the Engine it starts.
//
//   SPIKE_SIGN_IDENTITY=<Developer ID name or SHA-1> SPIKE_TEAM=<team> \
//   SPIKE_NOTARY_PROFILE=<notarytool keychain profile> node src/release.ts
//
// Without SPIKE_NOTARY_PROFILE it skips notarization (R2).
//
// R  the Developer ID-signed, notarized app
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { entitlementsFile } from './build.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const M0_DESKTOP = resolve(ROOT, '..', 'm0', 'desktop');
const SRC_APP = join(M0_DESKTOP, 'out', 'Draft Tide M0-darwin-arm64', 'Draft Tide M0.app');
const APP_ID = 'dev.drafttide.m0-spike';
const COMPANION_NODE_ID = 'dev.drafttide.m0-spike.companion-node';
const IDENTITY = process.env['SPIKE_SIGN_IDENTITY'];
const TEAM = process.env['SPIKE_TEAM'];
const NOTARY = process.env['SPIKE_NOTARY_PROFILE'];
if (!IDENTITY || !TEAM) throw new Error('set SPIKE_SIGN_IDENTITY and SPIKE_TEAM');
if (!existsSync(SRC_APP)) throw new Error(`missing ${SRC_APP}; build the M0 desktop spike first`);

const DEV_ID_MARKERS = 'certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const REQ = {
  product: `anchor apple generic and identifier "${APP_ID}" and certificate leaf[subject.OU] = "${TEAM}" and ${DEV_ID_MARKERS}`,
  teamOnly: `anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`,
};

// ------------------------------------------------------------------ harness
type Result = { id: string; description: string; ok: boolean; details?: unknown };
const results: Result[] = [];
function check(id: string, description: string, ok: boolean, details?: unknown): void {
  results.push(details === undefined ? { id, description, ok } : { id, description, ok, details });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} ${description}`);
  if (!ok && details !== undefined) console.log(`     ${JSON.stringify(details).slice(0, 800)}`);
}

interface Proc {
  child: ChildProcess;
  out: string[];
  err: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  done: boolean;
}
const baseEnv = { HOME: process.env['HOME'] ?? '', PATH: '/usr/bin:/bin', TMPDIR: process.env['TMPDIR'] ?? '/tmp' };
function run(cmd: string, args: string[], env: Record<string, string> = {}): Proc {
  const child = spawn(cmd, args, { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p: Proc = { child, out: [], err: '', done: false, exited: Promise.resolve({ code: null, signal: null }) };
  p.exited = new Promise((res) => child.on('exit', (code, signal) => { p.done = true; res({ code, signal }); }));
  child.stdout?.on('data', (d: Buffer) => p.out.push(...d.toString('utf8').split('\n').filter(Boolean)));
  child.stderr?.on('data', (d: Buffer) => (p.err += d.toString('utf8')));
  return p;
}
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number, step = 100): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}
// Runs a command and returns exit status and combined output (codesign and
// spctl report on stderr).
function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('/bin/sh', ['-c', '"$0" "$@" 2>&1', cmd, ...args], { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string };
    return { ok: false, out: err.stdout ?? String(e) };
  }
}
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}
function isMachO(file: string): boolean {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(4);
  const n = readSync(fd, buf, 0, 4, 0);
  closeSync(fd);
  if (n < 4) return false;
  const m = buf.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m);
}
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, acc);
    else if (st.isFile() && isMachO(p)) acc.push(p);
  }
  return acc;
}
function stopEngine(dataDir: string): void {
  try {
    const d = JSON.parse(readFileSync(join(dataDir, 'runtime', 'engine.json'), 'utf8')) as { pid: number };
    process.kill(d.pid, 'SIGTERM');
  } catch {
    // no engine started, or already gone
  }
}

// ------------------------------------------------------------------ sign
const work = join(ROOT, '.work', 'release');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const app = join(work, 'Draft Tide M0.app');
execFileSync('/usr/bin/ditto', [SRC_APP, app]);
const jitOnly = entitlementsFile(work, 'jit', ['com.apple.security.cs.allow-jit']);
const companionNode = join(app, 'Contents', 'Resources', 'node', 'bin', 'node');

console.log(`signing a copy of the M0 app with ${IDENTITY}`);
const { signAsync } = createRequire(join(M0_DESKTOP, 'package.json'))('@electron/osx-sign') as { signAsync: (o: Record<string, unknown>) => Promise<void> };
await signAsync({
  app,
  identity: IDENTITY,
  platform: 'darwin',
  type: 'distribution',
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  // Executables get JIT only (Electron and Node need it). Nothing gets
  // get-task-allow, dyld environment variables or a library-validation
  // exemption. The companion Node gets its own identifier, never the app's.
  optionsForFile: (file: string) => ({
    hardenedRuntime: true,
    entitlements: jitOnly,
    ...(file === companionNode && { additionalArguments: ['--identifier', COMPANION_NODE_ID] }),
  }),
});

// ------------------------------------------------------------------ R1 static
const strict = sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const machos = walk(app);
const bad: { file: string; problem: string }[] = [];
for (const f of machos) {
  const d = sh('/usr/bin/codesign', ['-dvvv', '--entitlements', '-', f]);
  const rel = relative(app, f);
  if (!/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(d.out)) bad.push({ file: rel, problem: 'no hardened runtime' });
  if (!d.out.includes(`TeamIdentifier=${TEAM}`)) bad.push({ file: rel, problem: 'not signed by the team' });
  if (/get-task-allow|allow-dyld-environment-variables|disable-library-validation/.test(d.out)) bad.push({ file: rel, problem: 'forbidden entitlement' });
}
const nodeIdent = /^Identifier=(.+)$/m.exec(sh('/usr/bin/codesign', ['-dv', companionNode]).out)?.[1];
const appStatic = sh('/usr/bin/codesign', ['--verify', `-R=${REQ.product}`, app]);
const nodeStatic = sh('/usr/bin/codesign', ['--verify', `-R=${REQ.product}`, companionNode]);
check('R1', `every Mach-O in the bundle (${machos.length}) is team-signed with hardened runtime and none carries get-task-allow, dyld variables or disable-library-validation; the bundle passes --deep --strict and the product requirement; the companion Node has its own identifier and fails it`, strict.ok && bad.length === 0 && appStatic.ok && !nodeStatic.ok && nodeIdent === COMPANION_NODE_ID, { strict: strict.out.slice(-300), bad, appStatic: appStatic.out.slice(-200), nodeIdent });

// ------------------------------------------------------------------ R2 notarize
if (NOTARY) {
  const zip = join(work, 'notarize.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  console.log('notarizing (this waits for Apple)…');
  const sub = sh('/usr/bin/xcrun', ['notarytool', 'submit', zip, '--keychain-profile', NOTARY, '--wait', '--output-format', 'json']);
  let status = '';
  let id = '';
  try {
    const j = JSON.parse(sub.out.slice(sub.out.indexOf('{'))) as { status?: string; id?: string };
    status = j.status ?? '';
    id = j.id ?? '';
  } catch {
    status = 'unparsed';
  }
  let log = '';
  if (status !== 'Accepted' && id) log = sh('/usr/bin/xcrun', ['notarytool', 'log', id, '--keychain-profile', NOTARY]).out;
  const staple = status === 'Accepted' ? sh('/usr/bin/xcrun', ['stapler', 'staple', app]) : { ok: false, out: '' };
  const gate = sh('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vvv', app]);
  check('R2', 'Apple notarizes the hardened bundle, the ticket staples, and Gatekeeper accepts it as Notarized Developer ID', status === 'Accepted' && staple.ok && gate.ok && gate.out.includes('Notarized Developer ID'), { status, id, staple: staple.out.slice(-200), gatekeeper: gate.out.trim(), log: log.slice(0, 600) });
} else {
  console.log('skip R2 (no SPIKE_NOTARY_PROFILE)');
}

// ------------------------------------------------------------------ R3–R5 running
const EXE = join(app, 'Contents', 'MacOS', 'Draft Tide M0');
const taskport = join(ROOT, '.work', 'build', 'taskport');
if (!existsSync(taskport)) throw new Error('run verify.ts with SPIKE_SIGN_IDENTITY first (it builds the taskport probe)');
{
  const data = join(work, 'data');
  const p = run(EXE, [], { DRAFT_TIDE_SMOKE_OUT: join(work, 'smoke'), DRAFT_TIDE_DATA_DIR: data });
  const engineJson = await until(() => existsSync(join(data, 'runtime', 'engine.json')) && (JSON.parse(readFileSync(join(data, 'runtime', 'engine.json'), 'utf8')) as { pid: number }), 15000);
  const mainPid = p.child.pid ?? -1;
  const enginePid = engineJson ? engineJson.pid : -1;
  const dyn = (pid: number, req: string) => sh('/usr/bin/codesign', ['--verify', `-R=${req}`, String(pid)]).ok;
  check('R3', 'the running signed app satisfies the product requirement by pid; the Engine it started (team-signed companion Node, loading the team-signed better-sqlite3 under library validation) is up and fails it but passes a team-only requirement', !!engineJson && dyn(mainPid, REQ.product) && !dyn(enginePid, REQ.product) && dyn(enginePid, REQ.teamOnly), { mainPid, enginePid, engineUp: !!engineJson, stderr: engineJson ? undefined : p.err.slice(-400) });
  const tp = (pid: number) => {
    const r = sh(taskport, [String(pid)]);
    return { granted: r.ok, out: r.out.trim() };
  };
  const tMain = tp(mainPid);
  const tEngine = enginePid > 0 ? tp(enginePid) : { granted: true, out: 'no engine' };
  check('R4', 'a same-user process with the debugger entitlement cannot get the task port of the signed app or of its Engine', !tMain.granted && !tEngine.granted, { main: tMain, engine: tEngine });
  p.child.kill('SIGUSR1');
  await sleep(1500);
  const inspector = /Debugger listening|Starting inspector/.test(p.err);
  check('R5', 'SIGUSR1 does not open an inspector in the signed app (fuse)', !inspector, { inspector });
  p.child.kill('SIGKILL');
  await p.exited;
  stopEngine(data);
}

// ------------------------------------------------------------------ R6 remote debugging
{
  const port = await freePort();
  const data = join(work, 'data-r6');
  const p = run(EXE, [`--remote-debugging-port=${port}`], { DRAFT_TIDE_SMOKE_OUT: join(work, 'smoke-r6'), DRAFT_TIDE_DATA_DIR: data });
  const target = await until(async () => {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) })).json()) as { url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.url.startsWith('app://gui/'));
    } catch {
      return undefined;
    }
  }, 15000);
  let value: unknown;
  if (target) {
    value = await until(async () => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const reply = new Promise<Record<string, any>>((res) => { ws.onmessage = (m) => { const msg = JSON.parse(String(m.data)) as Record<string, any>; if (msg['id'] === 1) res(msg); }; });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "typeof window.draftTide === 'object' ? window.draftTide.engineInfo().then((i) => JSON.stringify(i)) : ''", awaitPromise: true, returnByValue: true } }));
      const msg = await Promise.race([reply, sleep(8000).then(() => ({}))]);
      ws.close();
      const v = (msg as Record<string, any>)['result']?.['result']?.['value'];
      return typeof v === 'string' && v ? v : undefined;
    }, 8000, 200);
  }
  check('R6', 'signing and notarization do not stop --remote-debugging-port: another process still drives the desktop bridge of the signed app, so the Main guard is still required', typeof value === 'string' && value.includes('instanceId'), { target: target?.url, value: typeof value === 'string' ? value.slice(0, 120) : value });
  p.child.kill('SIGKILL');
  await p.exited;
  stopEngine(data);
}

// ------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
const out = join(ROOT, 'results');
mkdirSync(out, { recursive: true });
const osVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
writeFileSync(join(out, `release-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ macOS: osVersion, team: TEAM, appId: APP_ID, notarized: !!NOTARY, requirements: REQ, results }, null, 2));
process.exit(failed.length ? 1 : 0);
