// `draft-tide`: a thin Engine client (M1 plan §11.1). With --json, stdout gets
// exactly one envelope line and nothing else; diagnostics go to stderr. It
// never opens SQLite or runs Git.
import { Command, CommanderError } from 'commander';
import {
  DtError,
  errorEnvelope,
  exitCodeFor,
  okEnvelope,
  type Envelope,
  type ErrorCode,
  type OperationName,
} from '@draft-tide/contracts';
import { connectEngine, type EngineConnection } from '@draft-tide/engine-client';
import { BUILD } from '../build-info.ts';
import { engineLaunch } from '../engine-launch.ts';

const CLIENT = { name: 'draft-tide-cli', version: BUILD.appVersion };
const wantsJson = process.argv.includes('--json');

const HINTS: Partial<Record<ErrorCode, string>> = {
  AGENT_ACCESS_DISABLED: 'Turn on agent access in the Draft Tide app (Settings).',
  ENGINE_UNAVAILABLE: 'Try again, or open the Draft Tide app.',
  PROTOCOL_MISMATCH: 'This CLI and the running Draft Tide are different versions; update or restart the app.',
};

function emit(envelope: Envelope<unknown>, render: (data: never) => string): void {
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (envelope.ok) {
    process.stdout.write(render(envelope.data as never));
  } else if (envelope.error) {
    const hint = HINTS[envelope.error.code];
    process.stderr.write(`draft-tide: ${envelope.error.message} (${envelope.error.code})\n${hint ? `${hint}\n` : ''}`);
  }
  process.exitCode = exitCodeFor(envelope);
}

async function run<N extends OperationName>(
  op: N,
  payload: Record<string, unknown>,
  render: (data: never) => string,
): Promise<void> {
  const opts = program.opts<{ dataDir?: string }>();
  let conn: EngineConnection | null = null;
  try {
    conn = await connectEngine({
      channel: 'cli',
      client: CLIENT,
      launch: engineLaunch(),
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    });
    emit(okEnvelope(await conn.callRaw(op, payload)), render);
  } catch (e) {
    emit(errorEnvelope(e), render);
  } finally {
    conn?.close();
  }
}

const program = new Command('draft-tide')
  .description('Draft Tide: version history for your designs.')
  .version(BUILD.appVersion)
  .option('--json', 'print exactly one JSON envelope on stdout')
  .option('--data-dir <dir>', 'use another Draft Tide data directory (for testing)')
  .exitOverride()
  .showHelpAfterError();

const engine = program.command('engine').description('The local Draft Tide Engine');
engine
  .command('info')
  .description('Engine identity and versions, and whether agent access is on')
  .action(() =>
    run(
      'engine.info',
      {},
      (d: { appVersion: string; instanceId: string; agentAccess: { enabled: boolean }; desktopIdentity: string }) =>
        [
          `Draft Tide Engine ${d.appVersion} (${d.instanceId})`,
          `Agent access: ${d.agentAccess.enabled ? 'on' : 'off (turn it on in the Draft Tide app)'}`,
          `Desktop identity: ${d.desktopIdentity}`,
          '',
        ].join('\n'),
    ),
  );

const project = program.command('project').description('Design folders connected to Draft Tide');
project
  .command('list')
  .description('List connected design folders')
  .action(() =>
    run('project.list', {}, (list: { projectId: string; name: string; root: string }[]) =>
      list.length === 0
        ? 'No connected design folders.\n'
        : list.map((p) => `${p.projectId}  ${p.name}  ${p.root}\n`).join(''),
    ),
  );

program
  .command('mcp')
  .description('Model Context Protocol')
  .command('serve')
  .description('Run the local stdio MCP server (stdout carries MCP only)')
  .action(async () => {
    const { serveMcp } = await import('../mcp/server.ts');
    const opts = program.opts<{ dataDir?: string }>();
    await serveMcp(opts.dataDir ? { dataDir: opts.dataDir } : {});
  });

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') {
      process.exitCode = 0;
    } else {
      // Commander has already explained the problem on stderr.
      if (wantsJson)
        process.stdout.write(`${JSON.stringify(errorEnvelope(new DtError('INVALID_ARGUMENT', e.message)))}\n`);
      process.exitCode = 2;
    }
  } else {
    emit(errorEnvelope(e), () => '');
  }
}
