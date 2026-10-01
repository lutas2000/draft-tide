// Desktop identity spike: can the Engine tell the real desktop app from any
// other process of the same user, and what defeats that?
//
//   node src/verify.ts
//   SPIKE_SIGN_IDENTITY=<Developer ID> SPIKE_TEAM=<team> [SPIKE_APPLE_DEV_IDENTITY=<Apple Development> SPIKE_APPLE_DEV_TEAM=<team>] node src/verify.ts
//
// Without a Developer ID the "pinned" requirement uses the stand-in's cdhash.
// With one, it is the product requirement (anchor, identifier and team) and
// A12/A13 run as well.
//
// A  peer identity through the audit token and a code-signing requirement
// B  driving the genuine app from outside (remote debugging, SIGUSR1)
// C  attaching to the Engine itself (SIGUSR1 on the bundled Node)
// D  the socketpair alternative (desktop starts the Engine)
// E  hardened runtime on a team-signed companion Node (Developer ID only)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { ATTACKER_ID, DESKTOP_ID, TEAM_NODE_ID, build } from './build.ts';
import type { CodeCheck, PeerInfo } from './peer.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const M0_APP = resolve(ROOT, '..', 'm0', 'desktop', 'out', 'Draft Tide M0-darwin-arm64', 'Draft Tide M0.app');
const M0_EXE = join(M0_APP, 'Contents', 'MacOS', 'Draft Tide M0');
const BUNDLED_NODE = process.env['SPIKE_NODE'] ?? join(M0_APP, 'Contents', 'Resources', 'node', 'bin', 'node');
const ELECTRON = resolve(ROOT, '..', 'm0', 'desktop', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const NODE_TEAM = 'HX7739G8FX'; // Node.js Foundation: signer of the bundled Node
const INSPECTOR = /Debugger listening|Starting inspector/;
const DEV_ID = process.env['SPIKE_SIGN_IDENTITY'];
const TEAM = process.env['SPIKE_TEAM'];
const APPLE_DEV = process.env['SPIKE_APPLE_DEV_IDENTITY'];
const APPLE_DEV_TEAM = process.env['SPIKE_APPLE_DEV_TEAM'];
if (DEV_ID && !TEAM) throw new Error('SPIKE_SIGN_IDENTITY needs SPIKE_TEAM');
if (APPLE_DEV && !(DEV_ID && APPLE_DEV_TEAM)) throw new Error('SPIKE_APPLE_DEV_IDENTITY needs SPIKE_SIGN_IDENTITY and SPIKE_APPLE_DEV_TEAM');
// Developer ID markers: the intermediate (Developer ID CA) and the leaf's
// Developer ID Application extension, as in a Developer ID designated requirement.
const DEV_ID_MARKERS = 'certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

for (const p of [M0_EXE, BUNDLED_NODE, ELECTRON]) if (!existsSync(p)) throw new Error(`missing ${p}; build the M0 desktop spike first`);

// ------------------------------------------------------------------ harness
type Result = { id: string; description: string; ok: boolean; details?: unknown };
const results: Result[] = [];
function check(id: string, description: string, ok: boolean, details?: unknown): void {
  results.push(details === undefined ? { id, description, ok } : { id, description, ok, details });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} ${description}`);
  if (!ok && details !== undefined) console.log(`     ${JSON.stringify(details).slice(0, 600)}`);
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
  p.exited = new Promise((res) =>
    child.on('exit', (code, signal) => {
      p.done = true;
      res({ code, signal });
    }),
  );
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      p.out.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr?.on('data', (d: Buffer) => (p.err += d.toString('utf8')));
  return p;
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number, step = 50): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function devtoolsUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) })).ok;
  } catch {
    return false;
  }
}

async function cdpEval(wsUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const reply = new Promise<Record<string, any>>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as Record<string, any>;
      if (msg['id'] === 1) res(msg);
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await Promise.race([reply, sleep(8000).then(() => ({ timeout: true }))]);
  ws.close();
  return (msg as Record<string, any>)['result']?.['result']?.['value'] ?? msg;
}

function stopM0Engine(dataDir: string): void {
  try {
    const d = JSON.parse(readFileSync(join(dataDir, 'runtime', 'engine.json'), 'utf8')) as { pid: number };
    process.kill(d.pid, 'SIGTERM');
  } catch {
    // no engine started, or already gone
  }
}

const pick = (c: CodeCheck | undefined) => c && { valid: c.valid, identifier: c.identifier, teamId: c.teamId, adhoc: c.adhoc, lookupError: c.lookupError, checkStatus: c.checkStatus };

// ------------------------------------------------------------------ setup
const work = mkdtempSync(join(tmpdir(), 'dt-auth-'));
const b = build(ROOT, { ...(DEV_ID && { devId: DEV_ID, bundledNode: BUNDLED_NODE }), ...(APPLE_DEV && { appleDev: APPLE_DEV }) });
const osVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
const bundledNodeVersion = execFileSync(BUNDLED_NODE, ['--version'], { encoding: 'utf8' }).trim();
console.log(`desktop-auth spike  macOS ${osVersion}  bundled node ${bundledNodeVersion}  work=${work}`);

const requirements: Record<string, string> = {
  // The product requirement
  //   anchor apple generic and identifier "<app id>" and certificate leaf[subject.OU] = "<team>"
  // Without a Developer ID, the cdhash pins the exact binary instead.
  pinned: DEV_ID ? `anchor apple generic and identifier "${DESKTOP_ID}" and certificate leaf[subject.OU] = "${TEAM}"` : `identifier "${DESKTOP_ID}" and cdhash H"${b.desktopCdhash}"`,
  identOnly: `identifier "${DESKTOP_ID}"`,
  nodeTeam: `anchor apple generic and certificate leaf[subject.OU] = "${NODE_TEAM}"`,
};
if (DEV_ID) {
  requirements['pinnedDevId'] = `${requirements['pinned']} and ${DEV_ID_MARKERS}`;
  requirements['teamOnly'] = `anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`;
}
if (APPLE_DEV) {
  requirements['appleDevGeneric'] = `anchor apple generic and identifier "${DESKTOP_ID}" and certificate leaf[subject.OU] = "${APPLE_DEV_TEAM}"`;
  requirements['appleDevMarked'] = `${requirements['appleDevGeneric']} and ${DEV_ID_MARKERS}`;
}
writeFileSync(join(work, 'req.json'), JSON.stringify(requirements));
const sock = join(work, 'e.sock');
const server = run(BUNDLED_NODE, [join(ROOT, 'src', 'server.ts'), sock, b.addon, join(work, 'req.json')]);
if (!(await until(() => server.out.some((l) => l.includes('"ready"')), 5000))) throw new Error(`server did not start: ${server.err}`);

type Verdict = { event: string; mode: string; label: string; claimedPid: number; atRead: PeerInfo; peer: PeerInfo; byToken: Record<string, CodeCheck>; byPid: Record<string, CodeCheck> };
type HsVerdict = { event: string; mode: string; label: string; claimedPid: number; t0: PeerInfo; t0Check: CodeCheck; t1: PeerInfo | null; accepted: boolean; reason: string };
async function verdict<T = Verdict>(label: string): Promise<T> {
  const v = await until(() => server.out.map((l) => JSON.parse(l) as { event: string; label: string }).find((x) => x.event === 'verdict' && x.label === label), 8000);
  if (!v) throw new Error(`no verdict for ${label}: ${server.err}`);
  return v as T;
}

// ------------------------------------------------------------------ A
console.log('\nA  peer identity (stand-in Engine on the bundled Node)');
await run(b.desktopSim, ['connect', sock, 'desktop']).exited;
const vd = await verdict('desktop');
check('A1', 'the audit token names the connecting process (pid, uid)', vd.peer.pid === vd.claimedPid && vd.peer.euid === process.getuid?.(), vd.peer);
check('A2', `the signed desktop stand-in satisfies the pinned requirement${DEV_ID ? ' (Developer ID: anchor, identifier and team, with and without the Developer ID markers)' : ''}`, vd.byToken['pinned']?.valid === true && vd.byToken['pinned']?.identifier === DESKTOP_ID && (!DEV_ID || (vd.byToken['pinnedDevId']?.valid === true && vd.byToken['pinned']?.teamId === TEAM && !vd.byToken['pinned']?.adhoc)), { pinned: pick(vd.byToken['pinned']), pinnedDevId: pick(vd.byToken['pinnedDevId']) });

await run(b.forged, ['connect', sock, 'forged']).exited;
const vf = await verdict('forged');
check('A3', 'a different binary ad-hoc signed with the same identifier passes an identifier-only requirement and fails the pinned one', vf.byToken['identOnly']?.valid === true && vf.byToken['pinned']?.valid === false, { identOnly: pick(vf.byToken['identOnly']), pinned: pick(vf.byToken['pinned']) });

if (DEV_ID && b.teamNode) {
  const nodeClient0 = "const s=require('node:net').connect(process.argv[1],()=>s.write(JSON.stringify({label:process.argv[2],pid:process.pid})+'\\n'));s.on('data',()=>s.end())";
  await run(b.teamNode, ['-e', nodeClient0, sock, 'team-node']).exited;
  const vt = await verdict('team-node');
  check('A12', 'a script run by the companion Node re-signed with the team\'s Developer ID under its own identifier satisfies a team-only requirement but not the pinned one', vt.byToken['teamOnly']?.valid === true && vt.byToken['teamOnly']?.identifier === TEAM_NODE_ID && vt.byToken['pinned']?.valid === false && vt.byToken['pinnedDevId']?.valid === false, { teamOnly: pick(vt.byToken['teamOnly']), pinned: pick(vt.byToken['pinned']) });
}
if (APPLE_DEV && b.appleDevSigned) {
  await run(b.appleDevSigned, ['connect', sock, 'apple-dev']).exited;
  const va = await verdict('apple-dev');
  check('A13', 'an Apple Development signature with the desktop identifier satisfies `anchor apple generic` + identifier + its team, and fails once the Developer ID markers are required', va.byToken['appleDevGeneric']?.valid === true && va.byToken['appleDevMarked']?.valid === false && va.byToken['pinned']?.valid === false, { generic: pick(va.byToken['appleDevGeneric']), marked: pick(va.byToken['appleDevMarked']), pinned: pick(va.byToken['pinned']) });
}

const nodeClient = "const s=require('node:net').connect(process.argv[1],()=>s.write(JSON.stringify({label:process.argv[2],pid:process.pid})+'\\n'));s.on('data',()=>s.end())";
await run(BUNDLED_NODE, ['-e', nodeClient, sock, 'node-script']).exited;
const vn = await verdict('node-script');
check('A4', 'any script run by the Developer ID-signed Node satisfies an Apple-anchored requirement for its team (a signed interpreter is not an identity); it fails the pinned one', vn.byToken['nodeTeam']?.valid === true && vn.byToken['nodeTeam']?.teamId === NODE_TEAM && vn.byToken['pinned']?.valid === false, { nodeTeam: pick(vn.byToken['nodeTeam']), pinned: pick(vn.byToken['pinned']) });

await run(b.attacker, ['fork-race', sock, 'fork-race', b.desktopSim]).exited;
const vk = await verdict('fork-race');
check('A5', 'macOS reports the last process to use the socket, not the one that connected: a forked child that talks after its parent execs the genuine binary is seen as itself', vk.peer.pid === vk.claimedPid && vk.byToken['pinned']?.valid === false && vk.byToken['pinned']?.identifier === ATTACKER_ID, { peer: vk.peer, talkingPid: vk.claimedPid, byToken: pick(vk.byToken['pinned']) });

await run(b.attacker, ['send-exec', sock, 'send-exec', b.desktopSim]).exited;
const vx = await verdict('send-exec');
check('A6', 'a request sent just before its process execs the genuine binary is judged genuine by both the pid and the audit-token check (LOCAL_PEERTOKEN is computed when queried)', vx.peer.pid === vx.claimedPid && vx.byPid['pinned']?.valid === true && vx.byToken['pinned']?.valid === true, { atRead: vx.atRead, atCheck: vx.peer, byPid: pick(vx.byPid['pinned']), byToken: pick(vx.byToken['pinned']) });

await run(b.desktopSim, ['hs', sock, 'hs-honest']).exited;
const h1 = await verdict<HsVerdict>('hs-honest');
check('A7', 'handshake: the genuine client passes T0 and echoes the nonce from the same process instance', h1.accepted && h1.t0Check.valid, { t0: h1.t0, t1: h1.t1, reason: h1.reason });

await run(b.attacker, ['hs-send-exec', sock, 'hs-send-exec', b.desktopSim]).exited;
const h2 = await verdict<HsVerdict>('hs-send-exec');
check('A8', 'handshake: send-then-exec passes T0 (the genuine binary is there by then) but nobody echoes the nonce, so it is rejected', !h2.accepted && h2.t0Check.valid && h2.reason === 'no echo', { t0: h2.t0, t0Valid: h2.t0Check.valid, reason: h2.reason });

const eager = run(b.attacker, ['hs-fork-eager', sock, 'hs-fork-eager', b.desktopSim]);
await eager.exited;
const h3 = await verdict<HsVerdict>('hs-fork-eager');
check('A9', 'handshake: a forked child already blocked in read() on the socket is the reported peer at T0, so the attempt fails the requirement (receiving counts as use)', !h3.accepted && !h3.t0Check.valid && h3.t0.pid !== eager.child.pid, { t0: h3.t0, connectingPid: eager.child.pid, t0Identity: pick(h3.t0Check), reason: h3.reason });

await run(b.attacker, ['hs-fork', sock, 'hs-fork', b.desktopSim]).exited;
const h4 = await verdict<HsVerdict>('hs-fork');
check('A10', 'handshake: parent sends hello and execs the genuine binary, a forked child waits and then echoes the nonce; T0 passes but the echo comes from another pid, so it is rejected', !h4.accepted && h4.t0Check.valid && h4.reason === 'echo came from a different process instance', { t0: h4.t0, t1: h4.t1, reason: h4.reason });

const el = run(ELECTRON, [join(ROOT, 'electron', 'connect.mjs')], { SPIKE_SOCKET: sock, SPIKE_LABEL: 'electron-main' });
await el.exited;
const ve = await verdict('electron-main');
const eId = ve.byToken['identOnly'];
check('A11', 'an Electron main process is the peer itself, and its code resolves to the app bundle (not a helper)', ve.peer.pid === ve.claimedPid && eId?.identifier === 'Electron' && (eId.path ?? '').endsWith('Electron.app'), { peer: ve.peer, identifier: eId?.identifier, path: eId?.path, adhoc: eId?.adhoc });

server.child.kill('SIGTERM');
await server.exited;

// ------------------------------------------------------------------ B
console.log('\nB  driving the genuine app from outside');
{
  const port = await freePort();
  const data = join(work, 'm0-b1-data');
  const app = run(M0_EXE, [`--remote-debugging-port=${port}`], { DRAFT_TIDE_SMOKE_OUT: join(work, 'm0-b1-smoke'), DRAFT_TIDE_DATA_DIR: data });
  const target = await until(async () => {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) })).json()) as { url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.url.startsWith('app://gui/'));
    } catch {
      return undefined;
    }
  }, 15000);
  // The target appears at navigation; the preload bridge shortly after.
  const value = target ? await until(async () => { const v = await cdpEval(target.webSocketDebuggerUrl, "typeof window.draftTide === 'object' ? window.draftTide.engineInfo().then((i) => JSON.stringify(i)) : ''"); return typeof v === 'string' && v ? v : undefined; }, 8000, 200) : undefined;
  check('B1', 'another process launches the genuine packaged app with --remote-debugging-port and calls the desktop bridge from its GUI renderer', typeof value === 'string' && value.includes('instanceId'), { target: target?.url, value: typeof value === 'string' ? value.slice(0, 200) : value });
  app.child.kill('SIGTERM');
  await app.exited;
  stopM0Engine(data);
}
{
  const idle = join(ROOT, 'electron', 'idle.mjs');
  const p1 = await freePort();
  const open = run(ELECTRON, [`--remote-debugging-port=${p1}`, idle], { SPIKE_IDLE_MS: '3000' });
  const openUp = await until(() => devtoolsUp(p1), 5000);
  await open.exited;
  const p2 = await freePort();
  const guarded = run(ELECTRON, [`--remote-debugging-port=${p2}`, idle], { SPIKE_GUARD: '1' });
  let guardedUp = false;
  while (!guarded.done) {
    if (await devtoolsUp(p2)) guardedUp = true;
    await sleep(25);
  }
  const g = await guarded.exited;
  check('B2', 'a guard at the top of Electron main refuses --remote-debugging-port and exits; without it the endpoint opens', openUp === true && g.code === 3 && !guardedUp, { control: { endpoint: openUp === true }, guarded: { exit: g, endpointSeen: guardedUp, devtoolsLine: /DevTools listening/.test(guarded.err), stderr: guarded.err.slice(0, 200) } });
}
{
  const dev = run(ELECTRON, [join(ROOT, 'electron', 'idle.mjs')], { SPIKE_IDLE_MS: '4000' });
  await until(() => dev.out.some((l) => l.includes('"up"')), 5000);
  dev.child.kill('SIGUSR1');
  await sleep(1500);
  const devInspector = INSPECTOR.test(dev.err);
  dev.child.kill('SIGKILL');
  const devExit = await dev.exited;

  const data = join(work, 'm0-b3-data');
  const pkg = run(M0_EXE, [], { DRAFT_TIDE_SMOKE_OUT: join(work, 'm0-b3-smoke'), DRAFT_TIDE_DATA_DIR: data });
  await until(() => existsSync(join(data, 'runtime', 'engine.json')), 10000);
  const alive = !pkg.done;
  pkg.child.kill('SIGUSR1');
  await sleep(1500);
  const pkgInspector = INSPECTOR.test(pkg.err);
  const pkgStillUp = !pkg.done;
  pkg.child.kill('SIGKILL');
  const pkgExit = await pkg.exited;
  stopM0Engine(data);
  check('B3', 'SIGUSR1 opens the Node inspector in a dev Electron main but not in the packaged app (EnableNodeCliInspectArguments fuse off)', devInspector && alive && !pkgInspector, { dev: { inspector: devInspector, exit: devExit }, packaged: { aliveBeforeSignal: alive, inspector: pkgInspector, survivedSignal: pkgStillUp, exit: pkgExit } });
}

// ------------------------------------------------------------------ C
console.log('\nC  attaching to the Engine itself');
{
  const idleNode = "console.log('up'); setInterval(() => {}, 1000)";
  const plain = run(BUNDLED_NODE, ['-e', idleNode]);
  await until(() => plain.out.includes('up'), 3000);
  plain.child.kill('SIGUSR1');
  await sleep(1500);
  const opened = INSPECTOR.test(plain.err);
  plain.child.kill('SIGKILL');
  await plain.exited;

  const hardened = run(BUNDLED_NODE, ['--disable-sigusr1', '-e', idleNode]);
  await until(() => hardened.out.includes('up'), 3000);
  hardened.child.kill('SIGUSR1');
  await sleep(1500);
  const opened2 = INSPECTOR.test(hardened.err);
  const survived = !hardened.done;
  hardened.child.kill('SIGKILL');
  const hExit = await hardened.exited;
  check('C1', 'SIGUSR1 from any same-user process opens an inspector in a bundled-Node process such as the Engine; --disable-sigusr1 prevents it', opened && !opened2, { plain: { inspector: opened, stderr: plain.err.split('\n')[0] }, disableSigusr1: { inspector: opened2, survivedSignal: survived, exit: hExit } });
}

// ------------------------------------------------------------------ D
console.log('\nD  socketpair: the desktop starts the Engine');
{
  const sp = run(ELECTRON, [join(ROOT, 'electron', 'spawn-engine.mjs')], { SPIKE_NODE: BUNDLED_NODE, SPIKE_CHILD: join(ROOT, 'src', 'socketpair-child.ts'), SPIKE_ADDON: b.addon });
  await sp.exited;
  const line = sp.out.find((l) => l.includes('"socketpair"'));
  const rep = line ? (JSON.parse(line) as { mainPid: number; childReport: { isSocket: boolean; peer: PeerInfo; identity: CodeCheck; hello: { mainPid: number } } }) : undefined;
  check('D1', 'Electron main can start the Engine with an inherited socketpair on fd 3: no path, and the peer token is Electron main', !!rep && rep.childReport.isSocket && rep.childReport.peer.pid === rep.mainPid && rep.childReport.identity.identifier === 'Electron' && rep.childReport.hello.mainPid === rep.mainPid, rep ?? { stderr: sp.err.slice(0, 400) });
}

// ------------------------------------------------------------------ E
if (DEV_ID && b.teamNode && b.teamNodeLoose && b.taskport && b.injectLib && b.adhocAddon) {
  console.log('\nE  hardened runtime on the companion Node (re-signed by the team)');
  const nodes = { official: BUNDLED_NODE, team: b.teamNode, loose: b.teamNodeLoose };
  type Probe = { taskPort: boolean; taskPortError: string; dyldInjected: boolean; signedAddon: string; adhocAddon: string };
  const probe = async (node: string): Promise<Probe> => {
    const idle = run(node, ['-e', "console.log('up'); setInterval(() => {}, 1000)"]);
    await until(() => idle.out.includes('up'), 3000);
    const tp = run(b.taskport!, [String(idle.child.pid)]);
    await tp.exited;
    idle.child.kill('SIGKILL');
    await idle.exited;
    const tpOut = JSON.parse(tp.out[0] ?? '{}') as { kr?: number; error?: string };
    const mark = join(work, 'inject-mark');
    rmSync(mark, { force: true });
    await run(node, ['-e', '0'], { DYLD_INSERT_LIBRARIES: b.injectLib!, DT_INJECT_MARK: mark }).exited;
    const load = async (addon: string) => {
      const p = run(node, ['-e', `try { require(${JSON.stringify(addon)}); console.log('loaded') } catch (e) { console.log('refused') }`]);
      await p.exited;
      return p.out[0] ?? '';
    };
    return { taskPort: tpOut.kr === 0, taskPortError: tpOut.error ?? '', dyldInjected: existsSync(mark), signedAddon: await load(b.addon), adhocAddon: await load(b.adhocAddon!) };
  };
  const pr = { official: await probe(nodes.official), team: await probe(nodes.team), loose: await probe(nodes.loose) };
  check('E1', 'a same-user process ad-hoc signed with the debugger entitlement gets the task port of the official Node (it carries get-task-allow), but not of the Node re-signed with hardened runtime and no get-task-allow', pr.official.taskPort && !pr.team.taskPort && !pr.loose.taskPort, { official: pr.official.taskPortError, team: pr.team.taskPortError, loose: pr.loose.taskPortError });
  check('E2', 'DYLD_INSERT_LIBRARIES injects a library into the official Node (allow-dyld-environment-variables) and is ignored by the re-signed one', pr.official.dyldInjected && !pr.team.dyldInjected && !pr.loose.dyldInjected, { official: pr.official.dyldInjected, team: pr.team.dyldInjected, loose: pr.loose.dyldInjected });
  check('E3', 'library validation: the re-signed Node loads a team-signed addon and refuses an ad-hoc one; adding disable-library-validation lets the ad-hoc one in', pr.team.signedAddon === 'loaded' && pr.team.adhocAddon === 'refused' && pr.loose.adhocAddon === 'loaded' && pr.official.adhocAddon === 'loaded', { official: [pr.official.signedAddon, pr.official.adhocAddon], team: [pr.team.signedAddon, pr.team.adhocAddon], loose: [pr.loose.signedAddon, pr.loose.adhocAddon] });

  const usr1 = async (args: string[]) => {
    const p = run(b.teamNode!, [...args, '-e', "console.log('up'); setInterval(() => {}, 1000)"]);
    await until(() => p.out.includes('up'), 3000);
    p.child.kill('SIGUSR1');
    await sleep(1500);
    const opened = INSPECTOR.test(p.err);
    p.child.kill('SIGKILL');
    await p.exited;
    return opened;
  };
  const plainUsr1 = await usr1([]);
  const hardenedUsr1 = await usr1(['--disable-sigusr1']);
  check('E4', 'hardened runtime does not stop SIGUSR1: the re-signed Node still opens an inspector, and --disable-sigusr1 is still needed', plainUsr1 && !hardenedUsr1, { plain: plainUsr1, disableSigusr1: hardenedUsr1 });
}

// ------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
const out = join(ROOT, 'results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `verify-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ macOS: osVersion, bundledNode: bundledNodeVersion, signing: DEV_ID ? { team: TEAM, appleDevTeam: APPLE_DEV_TEAM ?? null } : 'ad-hoc', desktopId: DESKTOP_ID, attackerId: ATTACKER_ID, requirements, results }, null, 2));
if (!process.env['SPIKE_KEEP_WORK']) rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
