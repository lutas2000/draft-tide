// Token custody spike (macOS). Builds the stand-in Engine as a Node SEA signed
// with a Developer ID under its own identifier, then checks:
//   L  what the SEA's launch environment can still do to it
//   K  who can read a keychain item the SEA created
//   D  whether the desktop can tell the SEA Engine from a fake one
//
//   SPIKE_SIGN_IDENTITY=<Developer ID Application SHA-1> SPIKE_TEAM=<team id> node src/verify.ts
//
// It creates one generic password (service dev.drafttide.spike.token-custody)
// in the login keychain and removes it at the end.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENTITY = process.env['SPIKE_SIGN_IDENTITY'];
const TEAM = process.env['SPIKE_TEAM'];
if (!IDENTITY || !TEAM) {
  console.error('set SPIKE_SIGN_IDENTITY (Developer ID Application) and SPIKE_TEAM');
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(root, '.work', 'build');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const sockDir = mkdtempSync(join(tmpdir(), 'dt-tc-'));

const ENGINE_ID = 'dev.drafttide.spike.engine';
const NODE_ID = 'dev.drafttide.spike.companion-node';
const ENGINE_REQ = `anchor apple generic and identifier "${ENGINE_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM}"`;
const TEAM_REQ = `anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const OFFICIAL_NODE = process.execPath;
const BASE_ENV = { HOME: process.env['HOME'] ?? '', TMPDIR: process.env['TMPDIR'] ?? '/tmp', USER: process.env['USER'] ?? '', LANG: 'en_US.UTF-8' };
const INSPECTOR = /Debugger listening on ws:\/\//;

// ---------- results
interface Result {
  id: string;
  desc: string;
  ok: boolean | null;
  detail: unknown;
}
const results: Result[] = [];
function check(id: string, desc: string, ok: boolean, detail: unknown = {}): void {
  results.push({ id, desc, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id} ${desc}`);
  if (!ok) console.log(`       ${JSON.stringify(detail)}`);
}
function obs(id: string, desc: string, detail: unknown): void {
  results.push({ id, desc, ok: null, detail });
  console.log(`  obs  ${id} ${desc}: ${JSON.stringify(detail)}`);
}

// ---------- processes
interface Ran {
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
}
function run(cmd: string, args: string[], env: Record<string, string>, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
    child.stdin.end(opts.stdin ?? '');
  });
}
function last(r: Ran): Record<string, unknown> {
  const line = r.out.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { unparsed: line, code: r.code, signal: r.signal, err: r.err.slice(0, 300) };
  }
}
interface Started {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  stop: () => Promise<void>;
}
async function start(cmd: string, args: string[], env: Record<string, string>, ready: RegExp): Promise<Started> {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<void>((r) => child.on('close', () => r()));
  const deadline = Date.now() + 10_000;
  while (!ready.test(out) && Date.now() < deadline && child.exitCode === null) await sleep(50);
  return {
    child,
    out: () => out,
    err: () => err,
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const shAll = (cmd: string, args: string[]) => execFileSync('/bin/sh', ['-c', '"$0" "$@" 2>&1', cmd, ...args], { encoding: 'utf8' });

// ---------- build
function plist(name: string, keys: string[]): string {
  const f = join(work, `${name}.plist`);
  const body = keys.map((k) => `  <key>${k}</key><true/>`).join('\n');
  writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`);
  return f;
}
const JIT = plist('jit', ['com.apple.security.cs.allow-jit']);
const LOOSE = plist('loose', ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']);
const DEBUGGER = plist('debugger', ['com.apple.security.cs.debugger']);

function sign(bin: string, how: { identity: string; identifier: string; entitlements?: string }): void {
  const args = ['--force', '--sign', how.identity, '--options', 'runtime', '--identifier', how.identifier];
  if (how.identity !== '-') args.push('--timestamp');
  if (how.entitlements) args.push('--entitlements', how.entitlements);
  execFileSync('/usr/bin/codesign', [...args, bin], { stdio: ['ignore', 'ignore', 'pipe'] });
}
const devId = (identifier: string, entitlements?: string) => ({ identity: IDENTITY, identifier, ...(entitlements ? { entitlements } : {}) });

const nodeInclude = join(dirname(dirname(OFFICIAL_NODE)), 'include', 'node');
const clang = (args: string[]) => execFileSync('/usr/bin/xcrun', ['clang', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
function addon(src: string, name: string, frameworks: string[]): string {
  const outFile = join(work, `${name}.node`);
  clang(['-O2', '-Wall', '-bundle', '-undefined', 'dynamic_lookup', `-DNODE_GYP_MODULE_NAME=${name}`, `-I${nodeInclude}`, src, ...frameworks.flatMap((f) => (f.startsWith('-') ? [f] : ['-framework', f])), '-o', outFile]);
  return outFile;
}

console.log('building');
const keychainAddon = addon(join(root, 'native', 'keychain.c'), 'keychain', ['Security', 'CoreFoundation']);
sign(keychainAddon, devId('dev.drafttide.spike.keychain-addon'));
const peerAddon = addon(join(root, '..', 'desktop-auth', 'native', 'peer.c'), 'peer', ['Security', 'CoreFoundation', '-lbsm']);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', peerAddon]);
const sqliteAddon = join(work, 'better_sqlite3.node');
copyFileSync(join(root, '..', '..', 'node_modules', '.pnpm', 'better-sqlite3@13.0.3', 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64.node'), sqliteAddon);
sign(sqliteAddon, devId('dev.drafttide.spike.better-sqlite3'));
const injectLib = join(work, 'inject.dylib');
clang(['-O2', '-Wall', '-dynamiclib', join(root, '..', 'desktop-auth', 'native', 'inject.c'), '-o', injectLib]);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', injectLib]);
const taskport = join(work, 'taskport');
clang(['-O2', '-Wall', join(root, '..', 'desktop-auth', 'native', 'taskport.c'), '-o', taskport]);
sign(taskport, { identity: '-', identifier: 'dev.drafttide.spike.taskport', entitlements: DEBUGGER });

function blob(tag: string, config: Record<string, unknown>): string {
  const src = readFileSync(join(root, 'sea', 'engine.cjs'), 'utf8').replace('__BUILD__', tag);
  const main = join(work, `engine-${tag}.cjs`);
  writeFileSync(main, src);
  const out = join(work, `engine-${tag}.blob`);
  const cfg = join(work, `sea-${tag}.json`);
  writeFileSync(cfg, JSON.stringify({ main, output: out, disableExperimentalSEAWarning: true, ...config }));
  sh(OFFICIAL_NODE, ['--experimental-sea-config', cfg]);
  return out;
}
// One directory per executable: the Engine loads its addons from beside itself.
function sea(name: string, blobFile: string, how: { identity: string; identifier: string; entitlements?: string }): string {
  const dir = join(work, name);
  mkdirSync(dir);
  const exe = join(dir, 'engine');
  copyFileSync(OFFICIAL_NODE, exe);
  execFileSync('/usr/bin/codesign', ['--remove-signature', exe]);
  sh(join(root, 'node_modules', '.bin', 'postject'), [exe, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', FUSE, '--macho-segment-name', 'NODE_SEA']);
  sign(exe, how);
  copyFileSync(keychainAddon, join(dir, 'keychain.node'));
  copyFileSync(sqliteAddon, join(dir, 'better_sqlite3.node'));
  return exe;
}
const hardened = { execArgv: ['--disable-sigusr1'], execArgvExtension: 'none' };
const v1Blob = blob('v1', hardened);
const v1 = sea('v1', v1Blob, devId(ENGINE_ID, JIT));
const v2 = sea('v2', blob('v2', hardened), devId(ENGINE_ID, JIT));
const loose = sea('default', blob('default', {}), devId('dev.drafttide.spike.engine-default', JIT));
const noJit = sea('nojit', v1Blob, devId(ENGINE_ID));
const forged = sea('forged', v1Blob, { identity: '-', identifier: ENGINE_ID, entitlements: LOOSE });
const teamNode = join(work, 'companion-node');
copyFileSync(OFFICIAL_NODE, teamNode);
sign(teamNode, devId(NODE_ID, JIT));

const reader = join(root, 'sea', 'reader.cjs');
const env = (extra: Record<string, string> = {}) => ({ ...BASE_ENV, ...extra });
const servers: Started[] = [];
const secret = randomBytes(32).toString('hex');
const secretSha = createHash('sha256').update(secret).digest('hex');
let stored = false;

try {
  // ---------- L: the SEA and its launch environment
  console.log('\n## L. The SEA Engine and its launch environment');
  const dr = shAll('/usr/bin/codesign', ['-d', '-r-', v1]);
  const ents = shAll('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', v1]);
  const strict = run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', v1], env());
  const probe = last(await run(v1, ['probe', 'x'], env()));
  const verified = await strict;
  check(
    'L1',
    'the SEA is signed with the Developer ID under its own identifier, hardened runtime, JIT as its only entitlement, and runs',
    verified.code === 0 && dr.includes(`identifier "${ENGINE_ID}"`) && dr.includes(TEAM) && ents.includes('allow-jit') && !ents.includes('get-task-allow') && !ents.includes('disable-library-validation') && !ents.includes('dyld') && probe['build'] === 'v1',
    { designated: dr.split('\n').find((l) => l.startsWith('designated')), verify: verified.err.trim().split('\n').pop(), probe },
  );
  const nj = await run(noJit, ['probe'], env());
  obs('L2', 'the same SEA signed without allow-jit', { code: nj.code, signal: nj.signal, out: nj.out.trim().slice(0, 120), err: nj.err.trim().split('\n').slice(-2) });

  const evil = join(work, 'evil.cjs');
  writeFileSync(evil, 'globalThis.__evil = true;\n');
  const viaEnvDefault = last(await run(loose, ['raw-probe'], env({ NODE_OPTIONS: `--require ${evil}` })));
  const viaEnvNone = last(await run(v1, ['raw-probe'], env({ NODE_OPTIONS: `--require ${evil}` })));
  check('L3', 'NODE_OPTIONS runs code in a default SEA; with execArgvExtension "none" it is ignored', viaEnvDefault['evil'] === true && viaEnvNone['evil'] === false, { default: viaEnvDefault, none: viaEnvNone });

  const cli = last(await run(v1, ['probe', '--require', evil, '--inspect=0', '-e', 'globalThis.__evil=true'], env()));
  check('L4', 'Node options on the command line are only arguments to the SEA: nothing loaded, no inspector', cli['evil'] === false && cli['inspector'] === null && Array.isArray(cli['argv']) && (cli['argv'] as string[]).includes('--inspect=0'), cli);

  const usr1 = async (exe: string) => {
    const s = await start(exe, ['serve', join(sockDir, `usr1-${Math.random().toString(36).slice(2, 8)}.sock`)], env(), /ready/);
    s.child.kill('SIGUSR1');
    await sleep(1500);
    const opened = INSPECTOR.test(s.err());
    const alive = s.child.exitCode === null && s.child.signalCode === null;
    await s.stop();
    return { opened, alive };
  };
  const usr1Hardened = await usr1(v1);
  const usr1Default = await usr1(loose);
  check('L5', 'SIGUSR1 opens an inspector in a default SEA; execArgv ["--disable-sigusr1"] in the SEA config stops it', usr1Default.opened && !usr1Hardened.opened && usr1Hardened.alive, { hardened: usr1Hardened, default: usr1Default });

  const mark = (n: string) => join(work, `inject-${n}.mark`);
  await run(OFFICIAL_NODE, ['-e', '0'], env({ DYLD_INSERT_LIBRARIES: injectLib, DT_INJECT_MARK: mark('official') }));
  await run(v1, ['raw-probe'], env({ DYLD_INSERT_LIBRARIES: injectLib, DT_INJECT_MARK: mark('sea') }));
  check('L6', 'DYLD_INSERT_LIBRARIES injects into the official Node and is ignored by the SEA', existsSync(mark('official')) && !existsSync(mark('sea')), { official: existsSync(mark('official')), sea: existsSync(mark('sea')) });

  const seaServe = await start(v1, ['serve', join(sockDir, 'tp.sock')], env(), /ready/);
  servers.push(seaServe);
  const officialIdle = await start(OFFICIAL_NODE, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], env(), /ready/);
  servers.push(officialIdle);
  const tpSea = last(await run(taskport, [String(seaServe.child.pid)], env()));
  const tpOfficial = last(await run(taskport, [String(officialIdle.child.pid)], env()));
  check('L7', 'a debugger-entitled same-user probe gets the official Node\'s task port but not the SEA\'s', tpSea['kr'] !== 0 && tpOfficial['kr'] === 0, { sea: tpSea, official: tpOfficial });

  // TLS and proxy variables
  const certDir = join(work, 'tls');
  mkdirSync(certDir);
  sh('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  const tls = createHttpsServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (_req, res) => res.end('mitm'));
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', () => r()));
  const url = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
  const tlsRun = async (mode: string, extra: Record<string, string>): Promise<Record<string, unknown>> => {
    const r = await run(v1, [mode, url], env(extra));
    return { code: r.code, ...last(r) };
  };
  const baseline = await tlsRun('raw-tls', {});
  const rejectOff = await tlsRun('raw-tls', { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  const extraCa = await tlsRun('raw-tls', { NODE_EXTRA_CA_CERTS: join(certDir, 'cert.pem') });
  const guardedReject = await tlsRun('tls', { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  const guardedCa = await tlsRun('tls', { NODE_EXTRA_CA_CERTS: join(certDir, 'cert.pem') });
  tls.close();
  check(
    'L8',
    'the SEA still honors NODE_TLS_REJECT_UNAUTHORIZED=0 and NODE_EXTRA_CA_CERTS (a self-signed server is accepted); the environment allowlist refuses to start with them',
    baseline['ok'] === false && rejectOff['ok'] === true && extraCa['ok'] === true && guardedReject.code === 78 && guardedCa.code === 78,
    { baseline, rejectOff, extraCa, guardedReject, guardedCa },
  );

  const seen: string[] = [];
  const proxy = createNetServer((s) => {
    s.once('data', (d: Buffer) => {
      seen.push(d.toString().split('\r\n')[0] ?? '');
      s.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyEnv = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` };
  const rawProxy = last(await run(v1, ['raw-tls', 'https://api.github.com/'], env(proxyEnv)));
  const seenRaw = [...seen];
  const guardedProxy = await run(v1, ['tls', 'https://api.github.com/'], env(proxyEnv));
  proxy.close();
  check(
    'L9',
    'NODE_USE_ENV_PROXY + HTTPS_PROXY route the SEA\'s fetch through any proxy; the allowlist refuses to start with them',
    seenRaw.some((l) => l.startsWith('CONNECT api.github.com:443')) && guardedProxy.code === 78 && seen.length === seenRaw.length,
    { raw: rawProxy, proxySaw: seenRaw, guarded: last(guardedProxy) },
  );

  const emptyEnv = last(await run(v1, ['probe'], {}));
  const shellish = await run(v1, ['probe'], env({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }));
  check('L10', 'with only allowlisted variables (or none) the SEA starts; anything else, even PATH, is refused', emptyEnv['build'] === 'v1' && shellish.code === 78, { empty: emptyEnv, withPath: last(shellish) });

  const sqlite = last(await run(v1, ['sqlite'], env()));
  check('L11', 'the SEA loads the team-signed better-sqlite3 prebuild under library validation', sqlite['loaded'] === true, sqlite);

  // ---------- K: the keychain item
  console.log('\n## K. Who can read the item the SEA created');
  const st = last(await run(v1, ['store'], env(), { stdin: secret }));
  stored = st['status'] === 0;
  const r1 = last(await run(v1, ['read'], env(), { timeoutMs: 60_000 }));
  check('K1', 'the SEA stores the token and reads it back without any dialog', stored && r1['status'] === 0 && r1['sha256'] === secretSha, { store: st, read: { ...r1, sha256: r1['sha256'] === secretSha ? 'matches' : r1['sha256'] } });
  const r2 = last(await run(v2, ['read'], env(), { timeoutMs: 60_000 }));
  check('K2', 'a new build (different code, same identifier and team) reads it without a dialog, so updates keep the token', r2['build'] === 'v2' && r2['status'] === 0 && r2['sha256'] === secretSha, { ...r2, sha256: r2['sha256'] === secretSha ? 'matches' : r2['sha256'] });
  const byTeamNode = last(await run(teamNode, [reader, 'read', keychainAddon], env(), { timeoutMs: 60_000 }));
  check('K3', 'a script on the team-signed companion Node (same team, other identifier) cannot read it without asking the user', byTeamNode['status'] !== 0 && byTeamNode['sha256'] == null && byTeamNode['loadError'] === undefined, byTeamNode);
  const byOfficial = last(await run(OFFICIAL_NODE, [reader, 'read', keychainAddon], env(), { timeoutMs: 60_000 }));
  check('K4', 'a script on the official Node cannot read it without asking the user', byOfficial['status'] !== 0 && byOfficial['sha256'] == null && byOfficial['loadError'] === undefined, byOfficial);
  const byForged = last(await run(forged, ['read'], env(), { timeoutMs: 60_000 }));
  check('K5', 'an ad-hoc SEA with the Engine\'s identifier (and library validation off) cannot read it without asking', byForged['status'] !== 0 && byForged['sha256'] == null, byForged);
  obs('K6', 'statuses other readers get', { teamNode: byTeamNode['status'], official: byOfficial['status'], forged: byForged['status'], meaning: byTeamNode['message'] });

  // ---------- D: the desktop checks the Engine
  console.log('\n## D. The desktop checks who serves the Engine socket');
  const realSock = join(sockDir, 'engine.sock');
  servers.push(await start(v1, ['serve', realSock], env(), /ready/));
  const fakeSock = join(sockDir, 'fake.sock');
  servers.push(await start(teamNode, [reader, 'serve', fakeSock], env(), /ready/));
  const real = last(await run(OFFICIAL_NODE, [join(root, 'sea', 'check-peer.cjs'), peerAddon, realSock, ENGINE_REQ, TEAM_REQ], env())) as unknown as { valid: boolean }[];
  const fake = last(await run(OFFICIAL_NODE, [join(root, 'sea', 'check-peer.cjs'), peerAddon, fakeSock, ENGINE_REQ, TEAM_REQ], env())) as unknown as { valid: boolean }[];
  check('D1', 'the SEA Engine satisfies the Engine requirement; a script on the team-signed companion Node passes team-only but not the Engine requirement', real[0]?.valid === true && fake[0]?.valid === false && fake[1]?.valid === true, { real, fake });
} finally {
  for (const s of servers) await s.stop();
  if (existsSync(v1)) {
    const rm = last(await run(v1, ['remove'], env()));
    const after = last(await run(v1, ['read'], env()));
    if (stored) check('K7', 'the SEA removes the item; afterwards it is gone (errSecItemNotFound)', rm['status'] === 0 && after['status'] === -25300, { remove: rm, after });
  }
  rmSync(sockDir, { recursive: true, force: true });
}

const failed = results.filter((r) => r.ok === false).length;
const passed = results.filter((r) => r.ok === true).length;
mkdirSync(join(root, 'results'), { recursive: true });
writeFileSync(join(root, 'results', `verify-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ node: process.version, team: TEAM, results }, null, 2));
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exitCode = failed ? 1 : 0;
