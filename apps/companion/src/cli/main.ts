// `draft-tide`: a thin Engine client (M1 plan §11.1). With --json, stdout gets
// exactly one envelope line and nothing else; diagnostics go to stderr. It
// never opens SQLite or runs Git.
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import {
  DtError,
  errorEnvelope,
  exitCodeFor,
  okEnvelope,
  type Envelope,
  type ErrorCode,
  type FileDiff,
  type HistoryEntry,
  type HistoryPage,
  type OperationName,
  type ProjectStatus,
  type SavedSnapshot,
  type SnapshotDiff,
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
  PROJECT_NOT_BOUND: 'List connected projects with `draft-tide project list`. New folders are connected in the app.',
  NO_CHANGES: 'The folder is the same as the newest version; nothing was saved.',
  SOURCE_BUSY: 'Files kept changing. Stop the tool that is writing to the folder, then save again.',
  LOCKED: 'Another Git program is using the repository. Nothing was changed; try again in a moment.',
  HISTORY_CHANGED: 'Someone else added to the history meanwhile. Nothing was overwritten; save again.',
  RECOVERY_REQUIRED: 'An earlier change did not finish. Open the Draft Tide app to complete it.',
  SNAPSHOT_NOT_FOUND: 'Use a snapshot id or commit id from `draft-tide --project <id> history`.',
};

// Text from Git or file names, safe to print on a terminal: no escape
// sequences or line breaks.
function safe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '\uFFFD');
}

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

function usage(message: string): never {
  throw new DtError('INVALID_ARGUMENT', message);
}

function requireProject(): string {
  const id = program.opts<{ project?: string }>().project;
  if (!id) usage('this command needs --project <id> (see `draft-tide project list`)');
  return id;
}

function count(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new InvalidArgumentError('must be a whole number');
  return n;
}

const CHANGE_MARK = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

function changeLine(c: { path: string; change: keyof typeof CHANGE_MARK; previousPath: string | null }): string {
  const path = c.previousPath ? `${safe(c.previousPath)} -> ${safe(c.path)}` : safe(c.path);
  return `  ${CHANGE_MARK[c.change]}  ${path}\n`;
}

function versionLabel(e: HistoryEntry): string {
  if (e.source === 'draft-tide' && e.snapshot) {
    const name = e.snapshot.name ? ` "${safe(e.snapshot.name)}"` : '';
    return `V${e.seq ?? '?'}${name} (${e.snapshot.kind}, ${e.snapshot.origin}) ${e.snapshot.snapshotId}`;
  }
  const what =
    e.source === 'copy' ? 'copied version' : e.source === 'unreadable' ? 'unreadable version' : 'external change';
  return `${what} "${safe(e.title)}" by ${safe(e.authorName)} ${e.commit}`;
}

function renderStatus(s: ProjectStatus): string {
  const lines = [`${safe(s.name)} (${s.project.projectId})`, `Folder: ${safe(s.project.root)} [${s.folder}]`];
  if (s.branch) lines.push(`Branch: ${safe(s.branch)}`);
  lines.push(s.tip ? `Newest: ${versionLabel(s.tip)}` : 'Newest: no versions yet');
  if (s.recoveryRequired) lines.push('An earlier save did not finish: open the Draft Tide app to complete it.');
  if (s.saving) lines.push('Saving now.');
  for (const b of s.blockers) lines.push(`Blocked: ${b.code} (${b.reason})`);
  if (s.unsupported.count > 0) lines.push(`Cannot be saved as they are: ${s.unsupported.count} item(s)`);
  let out = `${lines.join('\n')}\n`;
  if (s.changes === null) return out;
  const c = s.changes;
  if (c.total === 0) return `${out}No unsaved changes.\n`;
  out += `Unsaved changes: ${c.total} (${c.added} added, ${c.modified} modified, ${c.deleted} deleted, ${c.renamed} renamed)\n`;
  out += c.entries.map(changeLine).join('');
  if (c.entries.length < c.total) out += `  … and ${c.total - c.entries.length} more\n`;
  return out;
}

function renderSaved(s: SavedSnapshot): string {
  const name = s.name ? ` "${safe(s.name)}"` : '';
  return `Saved${name}: ${s.snapshotId} (${s.kind}, ${s.files} files, ${s.newObjects} new objects)\n`;
}

function renderHistory(h: HistoryPage): string {
  if (h.entries.length === 0) return 'No versions yet.\n';
  let out = h.entries.map((e) => `${e.committedAt ?? '—'}  ${versionLabel(e)}\n`).join('');
  if (h.nextSkip !== null) out += `… more: --skip ${h.nextSkip}\n`;
  return out;
}

function renderDiff(d: SnapshotDiff): string {
  const s = d.summary;
  let out = `${s.total} file(s) changed (${s.added} added, ${s.modified} modified, ${s.deleted} deleted, ${s.renamed} renamed)\n`;
  out += d.changes.map(changeLine).join('');
  if (d.truncated) out += '  … (list cut short)\n';
  return out;
}

function renderFileDiff(d: FileDiff): string {
  if (d.kind === 'summary') {
    const size = (f: { size: number | null } | null) => (f ? `${f.size ?? '?'} bytes` : 'absent');
    return `${safe(d.path)}: ${d.reason} (before: ${size(d.before)}, after: ${size(d.after)})\n`;
  }
  let out = `--- ${safe(d.path)}\n+++ ${safe(d.path)}\n`;
  for (const h of d.hunks) {
    out += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`;
    out += h.lines.map((l) => `${l[0] ?? ''}${safe(l.slice(1))}\n`).join('');
  }
  if (d.truncated) out += '… (diff cut short)\n';
  return out;
}

async function run<N extends OperationName>(
  op: N,
  payload: Record<string, unknown> | (() => Record<string, unknown>),
  render: (data: never) => string,
): Promise<void> {
  const opts = program.opts<{ dataDir?: string }>();
  let conn: EngineConnection | null = null;
  try {
    if (typeof payload === 'function') payload = payload();
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
  .option('--project <id>', 'the project to work on (see `project list`)')
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
  .command('status')
  .description("The project's folder and unsaved changes since the newest version (needs --project)")
  .action(() => run('project.status', () => ({ projectId: requireProject() }), renderStatus));

program
  .command('snapshot')
  .description('Save a version of the project folder (needs --project; exit code 3 when nothing changed)')
  .option('--message <name>', 'a name for the version')
  .action((options: { message?: string }) =>
    run(
      'snapshot.create',
      () => ({ projectId: requireProject(), ...(options.message !== undefined ? { name: options.message } : {}) }),
      renderSaved,
    ),
  );

program
  .command('history')
  .description("The project's versions and other tools' commits, newest first (needs --project)")
  .option('--limit <n>', 'how many entries (1–200, default 50)', count)
  .option('--skip <n>', 'start after this many entries', count)
  .action((options: { limit?: number; skip?: number }) =>
    run(
      'history.list',
      () => ({
        projectId: requireProject(),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.skip !== undefined ? { skip: options.skip } : {}),
      }),
      renderHistory,
    ),
  );

program
  .command('diff')
  .description('Changes between two versions, by snapshot id or commit id (needs --project)')
  .argument('<from>', 'the older version')
  .argument('<to>', 'the newer version')
  .option('--file <path>', 'show the line-by-line changes of one file')
  .action((from: string, to: string, options: { file?: string }) =>
    options.file !== undefined
      ? run('snapshot.diffFile', () => ({ projectId: requireProject(), from, to, path: options.file }), renderFileDiff)
      : run('snapshot.diff', () => ({ projectId: requireProject(), from, to }), renderDiff),
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
