// M0 Engine / entry-point validation. Runs against the dev sources by default
// or against a packaged companion when M0_CLI_NODE / M0_CLI_ENTRY /
// M0_ENGINE_MATCH / DRAFT_TIDE_GIT_ROOT point into the .app bundle.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePng } from '../storage/fixtures.ts';
import { connectEngine } from './client.ts';
import { runtimePaths } from './paths.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spikeDir = resolve(here, '..', '..');
const cliNode = process.env['M0_CLI_NODE'] ?? process.execPath;
const cliEntry = process.env['M0_CLI_ENTRY'] ?? join(spikeDir, 'src', 'cli.ts');
const engineMatch = process.env['M0_ENGINE_MATCH'] ?? join(spikeDir, 'src', 'engine', 'server.ts');
const label = process.env['M0_LABEL'] ?? 'dev';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = resolve(process.env['M0_WORK_DIR'] ?? join(spikeDir, '.work', `engine-${label}-${stamp}`));
const dataDir = join(work, 'data');
const design = join(work, 'design');
rmSync(work, { recursive: true, force: true });
mkdirSync(design, { recursive: true });
writeFileSync(join(design, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Aurora</h1><img src="hero.png">\n');
writeFileSync(join(design, 'style.css'), 'h1 { color: #235; }\n');
writeFileSync(join(design, 'hero.png'), makePng(640, 360, 1));

// A minimal environment, like a Designer's machine with no dev tools on PATH.
const cleanEnv: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '', DRAFT_TIDE_ENGINE_IDLE_MS: '4000' };
if (process.env['DRAFT_TIDE_GIT_ROOT']) cleanEnv['DRAFT_TIDE_GIT_ROOT'] = process.env['DRAFT_TIDE_GIT_ROOT'];
if (process.env['M0_ENGINE_NODE']) cleanEnv['M0_ENGINE_NODE'] = process.env['M0_ENGINE_NODE'];

type Check = { id: string; description: string; pass: boolean; details?: unknown };
const checks: Check[] = [];
function check(id: string, description: string, pass: boolean, details?: unknown): void {
  checks.push(details === undefined ? { id, description, pass } : { id, description, pass, details });
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}${details === undefined ? '' : '  ' + JSON.stringify(details).slice(0, 400)}`);
}

type Env = { ok: boolean; data: any; error: { code: string } | null };
function cli(args: string[]): Promise<{ env: Env | null; stdout: string; stderr: string; code: number | null }> {
  return new Promise((res) => {
    const p = spawn(cliNode, [cliEntry, '--data-dir', dataDir, '--json', ...args], { env: cleanEnv });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    p.on('close', (code) => {
      let env: Env | null = null;
      try {
        env = JSON.parse(stdout) as Env;
      } catch {
        env = null;
      }
      res({ env, stdout, stderr, code });
    });
  });
}
// Engines for THIS data dir only (other runs may still be idling): match the
// entry path, then check the process environment (`ps -E`, same user).
function enginePids(): number[] {
  let pids: number[];
  try {
    pids = execFileSync('/usr/bin/pgrep', ['-f', engineMatch], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
  return pids.filter((pid) => {
    try {
      return execFileSync('/bin/ps', ['-Eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(`DRAFT_TIDE_DATA_DIR=${dataDir}`);
    } catch {
      return false;
    }
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const engineEntryForDesktop = process.env['M0_ENGINE_ENTRY'];
const desktop = () =>
  connectEngine({
    client: 'desktop',
    dataDir,
    ...(process.env['M0_ENGINE_NODE'] ? { nodePath: process.env['M0_ENGINE_NODE'] } : {}),
    ...(engineEntryForDesktop ? { engineEntry: engineEntryForDesktop } : {}),
    env: cleanEnv,
  });

console.error(`label=${label} cli=${cliNode} ${cliEntry}\nwork=${work}`);
if (enginePids().length) console.error(`warning: engines already running for ${engineMatch}: ${enginePids().join(',')}`);

// 1. Cold start race: 12 CLI processes at once against an empty data dir.
let t = performance.now();
const race = await Promise.all(Array.from({ length: 12 }, () => cli(['engine', 'info'])));
const raceMs = performance.now() - t;
const ids = new Set(race.map((r) => r.env?.data?.instanceId));
await sleep(1000);
const pidsAfterRace = enginePids();
check('engine.single-writer', '12 concurrent cold-start clients all reach one Engine; losers exit', race.every((r) => r.env?.ok) && ids.size === 1 && pidsAfterRace.length === 1, { instanceIds: ids.size, runningEngines: pidsAfterRace.length, coldStartRaceMs: Math.round(raceMs), errors: race.filter((r) => !r.env?.ok).map((r) => r.stderr.slice(0, 200)) });
const info = race[0]?.env?.data;
check('engine.runtime', 'Engine runs on the expected Node with SQLite loaded and the expected Git', !!info?.sqliteVersion && !!info?.gitVersion, { nodeVersion: info?.nodeVersion, nodePath: info?.nodePath, sqlite: info?.sqliteVersion, git: info?.gitVersion, gitPath: info?.gitPath, gitSource: info?.gitSource });
check('cli.stdout', '--json stdout is exactly one JSON envelope line (diagnostics on stderr)', race.every((r) => r.stdout.trim().split('\n').length === 1 && r.env !== null));

// 2. Handshake: wrong protocol version and wrong token are refused, and no
// second Engine is started to "fix" the mismatch.
const mismatch = await connectEngine({ client: 'cli', dataDir, protocolVersion: 99, env: cleanEnv }).then(() => 'connected', (e: { code?: string }) => e.code ?? 'error');
const d = JSON.parse(readFileSync(runtimePaths(dataDir).discovery, 'utf8')) as { socket: string };
const net = await import('node:net');
const badToken = await new Promise<string>((res) => {
  const s = net.connect(d.socket, () => {
    const body = Buffer.from(JSON.stringify({ op: 'hello', requestId: 'x', protocolVersion: 1, storageSchemaVersion: 1, client: 'desktop', token: 'guess' }));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(body.length);
    s.write(Buffer.concat([h, body]));
  });
  s.on('data', (b: Buffer) => res(JSON.parse(b.subarray(4).toString()).error?.code ?? 'ok'));
  s.on('error', () => res('socket-error'));
});
check('engine.handshake', 'protocol mismatch -> PROTOCOL_MISMATCH without a second Engine; forged desktop token -> UNAUTHENTICATED', mismatch === 'PROTOCOL_MISMATCH' && badToken === 'UNAUTHENTICATED' && enginePids().length === 1, { mismatch, badToken });
const sockMode = (execFileSync('/usr/bin/stat', ['-f', '%Lp', d.socket], { encoding: 'utf8' }).trim());
const rtMode = (execFileSync('/usr/bin/stat', ['-f', '%Lp', runtimePaths(dataDir).runtimeDir], { encoding: 'utf8' }).trim());
check('engine.endpoint-perms', 'socket is 0600 and runtime dir 0700 (owner only)', sockMode === '600' && rtMode === '700', { socket: sockMode, runtimeDir: rtMode });

// 3. Desktop channel binds the folder (stands in for the GUI scope review).
const desk = await desktop();
const events: Record<string, unknown>[] = [];
desk.onEvent((e) => events.push(e));
await desk.call('events.subscribe');
const bound = await desk.call<{ projectId: string; baselineSnapshotId: string }>('project.bind', { root: design, entryFiles: ['index.html'], displayName: 'Aurora (engine test)' });
const projectId = bound.projectId;

const toolBind = await cli(['project', 'list']);
const toolTable = await connectEngine({ client: 'cli', dataDir, env: cleanEnv });
const toolApprove = await toolTable.call('approval.decide', { operationId: '00000000-0000-4000-8000-000000000000', decision: 'approve' }).then(() => 'ok', (e: { code?: string }) => e.code);
const toolBindOp = await toolTable.call('project.bind', { root: '/tmp' }).then(() => 'ok', (e: { code?: string }) => e.code);
check('auth.tool-channel', 'CLI/MCP channel has no approve or bind operation (UNKNOWN_OPERATION)', toolApprove === 'UNKNOWN_OPERATION' && toolBindOp === 'UNKNOWN_OPERATION' && toolBind.env?.data?.length === 1, { toolApprove, toolBindOp, capabilities: toolTable.capabilities });

// 4. CLI save / history / no-op.
writeFileSync(join(design, 'style.css'), 'h1 { color: #b30; }\n');
const snap = await cli(['--project', projectId, 'snapshot', '--message', 'Warmer headline']);
const noop = await cli(['--project', projectId, 'snapshot']);
const hist = await cli(['--project', projectId, 'history']);
check('cli.snapshot', 'CLI saves a version, second save is NO_CHANGES, history shows both', snap.env?.ok === true && noop.env?.error?.code === 'NO_CHANGES' && hist.env?.data?.length === 2, { snap: snap.env?.data, noop: noop.env?.error?.code });

// 5. MCP over stdio via the official SDK client.
const transport = new StdioClientTransport({ command: cliNode, args: [cliEntry, '--data-dir', dataDir, 'mcp', 'serve'], env: cleanEnv, stderr: 'pipe' });
const mcp = new Client({ name: 'm0-verify', version: '0.0.0' });
t = performance.now();
await mcp.connect(transport);
const tools = await mcp.listTools();
const mcpConnectMs = performance.now() - t;
const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Env> => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '{}';
  return JSON.parse(text) as Env;
};
const toolNames = tools.tools.map((x) => x.name).sort();
check('mcp.tools', 'MCP server lists the M0 tool set and no approve / shell / git tool', toolNames.length === 8 && !toolNames.some((n) => /approve|shell|git|exec/.test(n)), { tools: toolNames, connectMs: Math.round(mcpConnectMs) });
writeFileSync(join(design, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Aurora, by agent</h1><img src="hero.png">\n');
const mSnap = await callTool('snapshot_create', { projectId, name: 'Agent headline' });
const mHist = await callTool('history_list', { projectId });
check('mcp.snapshot', 'MCP save goes through the same Engine and is tagged agent-requested / mcp', mSnap.ok && mHist.data?.[0]?.kind === 'agent-requested' && mHist.data?.[0]?.origin === 'mcp' && mHist.data?.length === 3, { latest: mHist.data?.[0] });

// 6. Approval boundary.
const baseline = bound.baselineSnapshotId;
writeFileSync(join(design, 'style.css'), 'h1 { color: #0a0; } /* unsaved */\n');
const plan = await callTool('restore_plan', { projectId, snapshotId: baseline });
const opId = plan.data?.operationId as string;
const early = await callTool('restore_apply', { operationId: opId });
// Same caller kind as the MCP server, sending fields a model might invent.
const rawMcp = await connectEngine({ client: 'mcp', dataDir, env: cleanEnv });
const selfConfirm = await rawMcp.call('restore.apply', { operationId: opId, confirmed: true, approvalId: 'made-up', force: true }).then(() => 'ok', (e: { code?: string }) => e.code);
rawMcp.close();
const req = await callTool('operation_request_approval', { operationId: opId });
await sleep(200);
const gotEvent = events.some((e) => e['event'] === 'approval.requested');
const crossCaller = await cli(['restore', 'apply', opId]);
check('auth.no-self-approval', 'apply before approval, confirmed:true/force, and another caller are all refused; desktop is notified', early.error?.code === 'CONFIRMATION_REQUIRED' && selfConfirm === 'CONFIRMATION_REQUIRED' && req.error?.code === 'CONFIRMATION_REQUIRED' && gotEvent && crossCaller.env?.error?.code === 'APPROVAL_DENIED', { early: early.error?.code, selfConfirm, request: req.error?.code, desktopEvent: gotEvent, crossCaller: crossCaller.env?.error?.code });

await desk.call('approval.decide', { operationId: opId, decision: 'deny' });
const denied = await callTool('restore_apply', { operationId: opId });
check('auth.denied', 'a declined restore is reported as APPROVAL_DENIED and nothing is written', denied.error?.code === 'APPROVAL_DENIED' && readFileSync(join(design, 'style.css'), 'utf8').includes('unsaved'), { got: denied.error?.code });

const plan2 = await callTool('restore_plan', { projectId, snapshotId: baseline });
const op2 = plan2.data?.operationId as string;
await callTool('operation_request_approval', { operationId: op2 });
await desk.call('approval.decide', { operationId: op2, decision: 'approve' });
const st = await callTool('operation_status', { operationId: op2 });
const applied = await callTool('restore_apply', { operationId: op2 });
const replay = await callTool('restore_apply', { operationId: op2 });
const hist2 = await callTool('history_list', { projectId });
check('restore.via-mcp', 'approved restore applies once: protection + restore versions appended, files back to baseline, replay refused', st.data?.state === 'approved' && applied.ok && replay.error?.code === 'APPROVAL_DENIED' && hist2.data?.[0]?.kind === 'restore' && hist2.data?.[1]?.kind === 'pre-restore' && readFileSync(join(design, 'style.css'), 'utf8') === 'h1 { color: #235; }\n', { applied: applied.data, replay: replay.error?.code, versions: hist2.data?.length });

const plan3 = await callTool('restore_plan', { projectId, snapshotId: mHist.data?.[0]?.snapshotId });
const op3 = plan3.data?.operationId as string;
await callTool('operation_request_approval', { operationId: op3 });
await desk.call('approval.decide', { operationId: op3, decision: 'approve' });
writeFileSync(join(design, 'index.html'), '<h1>edited after approval</h1>\n');
const stale = await callTool('restore_apply', { operationId: op3 });
check('auth.stale', 'files changed after approval -> PLAN_STALE, the edit survives', stale.error?.code === 'PLAN_STALE' && readFileSync(join(design, 'index.html'), 'utf8').includes('edited after approval'), { got: stale.error?.code });
await mcp.close();
toolTable.close();

// 7. Engine memory after real work, then crash takeover.
const pid = enginePids()[0];
const rssKiB = pid ? Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) : 0;
desk.close();
if (pid) process.kill(pid, 'SIGKILL');
await sleep(300);
t = performance.now();
const after = await cli(['engine', 'info']);
const restartMs = performance.now() - t;
const pidsAfterCrash = enginePids();
check('engine.crash-takeover', 'after kill -9 the next client starts a new Engine (OS lock released; stale socket/discovery replaced)', after.env?.ok === true && after.env?.data?.instanceId !== info?.instanceId && pidsAfterCrash.length === 1, { restartMs: Math.round(restartMs), newInstance: after.env?.data?.instanceId !== info?.instanceId, pids: pidsAfterCrash, ps: pidsAfterCrash.map((p) => { try { return execFileSync('/bin/ps', ['-o', 'pid=,ppid=,stat=,etime=,command=', '-p', String(p)], { encoding: 'utf8' }).trim().slice(0, 160); } catch { return 'gone'; } }) });
const hist3 = await cli(['--project', projectId, 'history']);
check('engine.state-durable', 'SQLite registry and Git history survive the crash', hist3.env?.data?.length === hist2.data?.length, { versions: hist3.env?.data?.length });

// 8. Idle exit.
await sleep(6500);
check('engine.idle-exit', 'Engine exits on its own after the idle timeout with no clients', enginePids().length === 0, { running: enginePids() });

const results = { label, startedAt: stamp, cliNode, cliEntry, engineRssMiB: Math.round(rssKiB / 1024), checks, passed: checks.every((c) => c.pass) };
mkdirSync(join(spikeDir, 'results'), { recursive: true });
const out = join(spikeDir, 'results', `engine-${label}-${stamp}.json`);
writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
console.error(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed; engine RSS ${results.engineRssMiB} MiB\nresults: ${out}`);
for (const p of enginePids()) process.kill(p, 'SIGTERM');
if (process.env['M0_KEEP_WORK'] !== '1') rmSync(work, { recursive: true, force: true });
process.exit(results.passed ? 0 : 1);
