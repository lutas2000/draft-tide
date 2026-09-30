// `draft-tide` CLI (M0 spike subset of M1 plan §11.1). A thin Engine client:
// stdout carries results only (JSON envelope with --json), diagnostics go to
// stderr. It never opens SQLite or runs Git.
import { Command } from 'commander';
import { connectEngine, type EngineConnection } from './engine/client.ts';
import { errorEnvelope, okEnvelope, type Envelope } from './shared/errors.ts';

const program = new Command();
program
  .name('draft-tide')
  .description('Version history for your designs (M0 spike CLI)')
  .option('--data-dir <dir>', 'Draft Tide data directory')
  .option('--project <id>', 'project id (from `project list`)')
  .option('--json', 'print the JSON envelope on stdout')
  .showHelpAfterError();

function print(env: Envelope<unknown>): void {
  if (program.opts()['json']) {
    process.stdout.write(JSON.stringify(env) + '\n');
  } else if (env.ok) {
    process.stdout.write(JSON.stringify(env.data, null, 2) + '\n');
  } else {
    process.stderr.write(`error ${env.error?.code}: ${env.error?.message}\n`);
  }
  if (!env.ok) process.exitCode = 1;
}

async function withEngine(fn: (c: EngineConnection, project: string | undefined) => Promise<unknown>): Promise<void> {
  const o = program.opts() as { dataDir?: string; project?: string };
  let conn: EngineConnection | null = null;
  try {
    conn = await connectEngine(o.dataDir ? { client: 'cli', dataDir: o.dataDir } : { client: 'cli' });
    print(okEnvelope(await fn(conn, o.project)));
  } catch (e) {
    print(errorEnvelope(e));
  } finally {
    conn?.close();
  }
}

program.command('engine').command('info').description('Engine identity and bundled runtime versions').action(() => withEngine((c) => c.call('engine.info')));
program.command('project').command('list').description('Connected design folders').action(() => withEngine((c) => c.call('project.list')));
program.command('status').description('Latest version and unsaved changes').action(() => withEngine((c, p) => c.call('project.status', { projectId: p })));
program
  .command('snapshot')
  .description('Save a version')
  .option('--message <text>', 'version name')
  .action((o: { message?: string }) => withEngine((c, p) => c.call('snapshot.create', o.message ? { projectId: p, name: o.message } : { projectId: p })));
program.command('history').description('Saved versions, newest first').action(() => withEngine((c, p) => c.call('history.list', { projectId: p })));

const restore = program.command('restore').description('Restore an earlier version (needs confirmation in the app)');
restore.command('plan <snapshotId>').action((id: string) => withEngine((c, p) => c.call('restore.plan', { projectId: p, snapshotId: id })));
restore.command('apply <operationId>').action((id: string) => withEngine((c) => c.call('restore.apply', { operationId: id })));

const op = program.command('operation').description('Planned operations');
op.command('request-approval <operationId>').action((id: string) => withEngine((c) => c.call('operation.requestApproval', { operationId: id })));
op.command('status <operationId>').action((id: string) => withEngine((c) => c.call('operation.status', { operationId: id })));

program
  .command('mcp')
  .command('serve')
  .description('Run the local stdio MCP server')
  .action(async () => {
    const { serveMcp } = await import('./mcp.ts');
    const o = program.opts() as { dataDir?: string };
    await serveMcp(o.dataDir ? { dataDir: o.dataDir } : {});
  });

await program.parseAsync(process.argv);
