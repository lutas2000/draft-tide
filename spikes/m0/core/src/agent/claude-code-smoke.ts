// M0 agent compatibility experiment (ROADMAP §5): one public local host
// (Claude Code, headless) drives the packaged Draft Tide through MCP and the
// CLI, with the Skill loaded from project settings. The harness plays the
// Draft Tide app's confirmation channel (the user's click in the dialog).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectEngine } from '../engine/client.ts';
import { makePng } from '../storage/fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spikeDir = resolve(here, '..', '..');
const claude = process.env['M0_CLAUDE_BIN'] ?? process.env['CLAUDE_CODE_EXECPATH'] ?? 'claude';
const R = process.env['M0_RESOURCES'] ?? resolve(spikeDir, '..', 'desktop', 'out', 'Draft Tide M0-darwin-arm64', 'Draft Tide M0.app', 'Contents', 'Resources');
const MODEL = process.env['M0_AGENT_MODEL'] ?? 'haiku';
const BUDGET = process.env['M0_AGENT_BUDGET_USD'] ?? '0.60';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = join(spikeDir, '.work', `agent-${stamp}`);
const dataDir = join(work, 'data');
const design = join(work, 'aurora-design');
const agentDir = join(work, 'agent-project');
const outDir = join(spikeDir, 'results', `agent-${stamp}`);
for (const d of [design, join(agentDir, '.claude', 'skills', 'draft-tide'), join(agentDir, 'bin'), outDir]) mkdirSync(d, { recursive: true });

const BASE_H1 = 'Aurora pricing';
writeFileSync(join(design, 'index.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>\n<body>\n<h1>${BASE_H1}</h1>\n<p>Simple plans for every team.</p>\n<img src="hero.png" alt="">\n</body>\n</html>\n`);
writeFileSync(join(design, 'style.css'), 'body { font-family: system-ui; background: #f6f3ee; }\nh1 { color: #2f6f73; }\n');
writeFileSync(join(design, 'hero.png'), makePng(480, 120, 5, 0.3));

// Host configuration the GUI would generate: absolute bundled paths, no PATH.
const cli = join(agentDir, 'bin', 'draft-tide');
symlinkSync(join(R, 'bin', 'draft-tide'), cli);
const skill = readFileSync(join(spikeDir, '..', 'skill', 'draft-tide', 'SKILL.md'), 'utf8').replaceAll('{{DRAFT_TIDE_CLI}}', `${cli} --data-dir ${dataDir}`);
writeFileSync(join(agentDir, '.claude', 'skills', 'draft-tide', 'SKILL.md'), skill);
const mcpConfig = join(agentDir, 'draft-tide.mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'draft-tide': { type: 'stdio', command: join(R, 'node', 'bin', 'node'), args: [join(R, 'companion', 'cli.mjs'), '--data-dir', dataDir, 'mcp', 'serve'], env: { DRAFT_TIDE_ENGINE_IDLE_MS: '60000' } } } }, null, 2));

// The app side: bind the folder (scope review) and stay connected as desktop.
const desk = await connectEngine({ client: 'desktop', dataDir, nodePath: join(R, 'node', 'bin', 'node'), engineEntry: join(R, 'companion', 'engine.mjs'), env: { DRAFT_TIDE_ENGINE_IDLE_MS: '60000' } });
await desk.call('events.subscribe');
const approvalEvents: unknown[] = [];
desk.onEvent((e) => e['event'] === 'approval.requested' && approvalEvents.push(e));
const bound = await desk.call<{ projectId: string; baselineSnapshotId: string }>('project.bind', { root: design, entryFiles: ['index.html'], displayName: 'Aurora pricing' });

type ToolUse = { name: string; input: unknown };
type Turn = { label: string; sessionId: string; result: string; isError: boolean; costUsd: number; numTurns: number; tools: ToolUse[]; toolErrors: string[]; ms: number };
const turns: Turn[] = [];

// Only this session's identity variables are dropped; auth and config stay.
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|ENTRYPOINT)|CLAUDE_PID)$/.test(k))) as Record<string, string>;

function turn(label: string, prompt: string, opts: { resume?: string; mcp: boolean; allowedTools: string[] }): Promise<Turn> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--setting-sources', 'project', '--add-dir', design, '--max-budget-usd', BUDGET, '--allowedTools', ...opts.allowedTools];
  if (opts.mcp) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  else args.push('--strict-mcp-config');
  if (opts.resume) args.push('--resume', opts.resume);
  const t0 = Date.now();
  return new Promise((res) => {
    const p = spawn(claude, args, { cwd: agentDir, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const lines: string[] = [];
    p.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    let stderr = '';
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    p.on('close', () => {
      writeFileSync(join(outDir, `${label}.jsonl`), lines.join('\n') + '\n');
      const tools: ToolUse[] = [];
      const toolErrors: string[] = [];
      let final: Record<string, any> = {};
      for (const l of lines) {
        let m: Record<string, any>;
        try {
          m = JSON.parse(l) as Record<string, any>;
        } catch {
          continue;
        }
        if (m['type'] === 'assistant') for (const c of m['message']?.content ?? []) if (c.type === 'tool_use') tools.push({ name: c.name, input: c.input });
        if (m['type'] === 'user') for (const c of m['message']?.content ?? []) if (c.type === 'tool_result' && c.is_error) toolErrors.push(JSON.stringify(c.content).slice(0, 200));
        if (m['type'] === 'result') final = m;
      }
      const t: Turn = { label, sessionId: String(final['session_id'] ?? ''), result: String(final['result'] ?? stderr.slice(-500)), isError: !!final['is_error'], costUsd: Number(final['total_cost_usd'] ?? 0), numTurns: Number(final['num_turns'] ?? 0), tools, toolErrors, ms: Date.now() - t0 };
      turns.push(t);
      console.error(`\n== ${label} (${t.ms} ms, $${t.costUsd.toFixed(3)}, ${t.numTurns} turns) tools: ${tools.map((x) => x.name).join(', ')}\n${t.result.slice(0, 700)}`);
      res(t);
    });
  });
}

type Check = { id: string; description: string; pass: boolean; details?: unknown };
const checks: Check[] = [];
const check = (id: string, description: string, pass: boolean, details?: unknown) => {
  checks.push(details === undefined ? { id, description, pass } : { id, description, pass, details });
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}${details === undefined ? '' : '  ' + JSON.stringify(details).slice(0, 300)}`);
};
const h1 = () => /<h1>(.*?)<\/h1>/.exec(readFileSync(join(design, 'index.html'), 'utf8'))?.[1] ?? '';
const history = () => desk.call<{ kind: string; name: string | null; origin: string; restoreOf: string | null; snapshotId: string }[]>('history.list', { projectId: bound.projectId });
const MCP_TOOLS = ['mcp__draft-tide', 'Read', 'Edit', 'Skill', 'Glob', 'Grep'];

// Preflight: headless hosts need their own login; stop cleanly if missing.
const pre = await turn('t0-preflight', 'Reply with the single word: ready', { mcp: false, allowedTools: [] });
if (/not logged in|\/login/i.test(pre.result)) {
  console.error(`\nBLOCKED: ${claude} is not logged in for headless use. Run it once interactively and /login, then re-run.`);
  desk.close();
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ blocked: 'host-not-logged-in', hostReply: pre.result }, null, 2) + '\n');
  if (process.env['M0_KEEP_WORK'] !== '1') rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

const t1 = await turn('t1-edit-save-history', `My design folder is ${design}. Use the draft-tide skill. Change the <h1> text in index.html to "Aurora keeps every draft", save a version named "New headline", then show me the version history.`, { mcp: true, allowedTools: MCP_TOOLS });
const h1v = await history();
check('agent.save', 'agent edits the file, saves through MCP, history shows an agent-requested version with its name', h1() === 'Aurora keeps every draft' && h1v[0]?.kind === 'agent-requested' && h1v[0]?.origin === 'mcp' && h1v.length === 2, { h1: h1(), latest: h1v[0], tools: t1.tools.map((x) => x.name) });
check('agent.skill-loaded', 'the project Skill is discoverable and used by the host', t1.tools.some((x) => x.name === 'Skill') || t1.result.includes('snapshot') || t1.tools.some((x) => x.name.startsWith('mcp__draft-tide__project_list')), { skillToolCalled: t1.tools.some((x) => x.name === 'Skill') });

const t2 = await turn('t2-request-restore', 'Please go back to the first version of the design.', { resume: t1.sessionId, mcp: true, allowedTools: MCP_TOOLS });
const pending = await desk.call<{ operationId: string; requestedBy: string; summary: unknown }[]>('approval.list');
check('agent.requests-confirmation', 'restore request ends in CONFIRMATION_REQUIRED; nothing is written; the app is notified', pending.length === 1 && pending[0]?.requestedBy === 'mcp' && h1() === 'Aurora keeps every draft' && approvalEvents.length >= 1, { pending: pending.length, h1: h1(), tools: t2.tools.map((x) => x.name) });
check('agent.no-false-success', 'agent tells the user to confirm in Draft Tide instead of claiming the restore happened', /Draft Tide|app|confirm/i.test(t2.result) && !/restored successfully|has been restored/i.test(t2.result), { reply: t2.result.slice(0, 300) });

// The designer clicks 回復到此版 in the app.
if (pending[0]) await desk.call('approval.decide', { operationId: pending[0].operationId, decision: 'approve' });
const t3 = await turn('t3-finish-after-approval', 'I confirmed it in the Draft Tide app. Please finish.', { resume: t1.sessionId, mcp: true, allowedTools: MCP_TOOLS });
const h3 = await history();
check('agent.apply-after-approval', 'after the in-app approval the agent applies it; files are back to V1 and history was appended, not rewound', h1() === BASE_H1 && h3[0]?.kind === 'restore' && h3[0]?.restoreOf === bound.baselineSnapshotId && h3.length >= 3, { h1: h1(), versions: h3.map((v) => v.kind), tools: t3.tools.map((x) => x.name) });

const t4 = await turn('t4-request-again', 'Now switch back to the "New headline" version.', { resume: t1.sessionId, mcp: true, allowedTools: MCP_TOOLS });
const pending2 = await desk.call<{ operationId: string }[]>('approval.list');
if (pending2[0]) await desk.call('approval.decide', { operationId: pending2[0].operationId, decision: 'deny' }); // the designer declines
const t5 = await turn('t5-after-decline', 'I made my decision in the Draft Tide app.', { resume: t1.sessionId, mcp: true, allowedTools: MCP_TOOLS });
const h5 = await history();
check('agent.respects-decline', 'a declined restore is reported as declined; files and history unchanged; no retry', pending2.length === 1 && h1() === BASE_H1 && h5.length === h3.length && /declin|denied|reject/i.test(t5.result), { reply: t5.result.slice(0, 300), tools: t5.tools.map((x) => x.name) });

const t6 = await turn('t6-cli-only', `Without MCP, use the draft-tide CLI described in the skill to list the saved versions of the project whose folder is ${design}, and tell me how many versions there are.`, { mcp: false, allowedTools: [`Bash(${cli}:*)`, 'Skill', 'Read'] });
const usedCli = t6.tools.some((x) => x.name === 'Bash' && JSON.stringify(x.input).includes('draft-tide'));
check('agent.cli-json', 'with MCP disabled the agent uses the bundled CLI JSON output and reports the right count', usedCli && t6.result.includes(String(h5.length)), { versions: h5.length, reply: t6.result.slice(0, 200), bash: t6.tools.filter((x) => x.name === 'Bash').map((x) => x.input) });

desk.close();
const hostVersion = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
const summary = {
  host: { name: 'Claude Code (headless -p)', version: hostVersion, model: MODEL, platform: `${process.platform}-${process.arch}`, transport: 'stdio (MCP)', skill: 'project .claude/skills/draft-tide/SKILL.md via --setting-sources project', mcpConfig: '--mcp-config file + --strict-mcp-config (user config untouched)' },
  checks,
  passed: checks.every((c) => c.pass),
  totalCostUsd: Number(turns.reduce((a, t) => a + t.costUsd, 0).toFixed(4)),
  turns: turns.map((t) => ({ label: t.label, ms: t.ms, costUsd: t.costUsd, tools: t.tools.map((x) => x.name), toolErrors: t.toolErrors, reply: t.result.slice(0, 600) })),
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.error(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed, total $${summary.totalCostUsd}\nresults: ${outDir}`);
if (process.env['M0_KEEP_WORK'] !== '1') rmSync(work, { recursive: true, force: true });
process.exit(summary.passed ? 0 : 1);
