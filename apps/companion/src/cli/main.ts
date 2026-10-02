// `draft-tide`: a thin Engine client (M1 plan §11.1). With --json, stdout gets
// exactly one envelope line and nothing else; diagnostics go to stderr. It
// never opens SQLite or runs Git.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import {
  DtError,
  errorEnvelope,
  exitCodeFor,
  okEnvelope,
  type Envelope,
  type ErrorCode,
  type CommitRef,
  type FileDiff,
  type HistoryEntry,
  type HistoryPage,
  type OperationCancelResult,
  type OperationName,
  type OperationStatus,
  type PreviewArtifact,
  type PreviewChunk,
  type ProjectStatus,
  type RecoveryPlan,
  type RecoveryReport,
  type RecoveryResult,
  type RestorePlan,
  type RestoreResult,
  type SavedSnapshot,
  type SnapshotDiff,
  type VersionInfo,
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
  RECOVERY_REQUIRED:
    'An earlier change stopped part-way. See `draft-tide --project <id> recover inspect`, or open the Draft Tide app.',
  SNAPSHOT_NOT_FOUND: 'Use a snapshot id or commit id from `draft-tide --project <id> history`.',
  PLAN_STALE: 'Files changed since the plan was made. Make a new plan and check it again.',
  UNTRACKED_FILES: 'Files no version holds are in the way. Move them, or save them first, then plan again.',
  CONFIRMATION_REQUIRED:
    'Only the user can do this, in the Draft Tide app. Follow the request with `draft-tide operation status <id>`.',
  APPROVAL_DENIED: 'The user declined the request in the Draft Tide app.',
  CANCELLED: 'The operation was cancelled before it changed anything.',
  PREVIEW_UNSUPPORTED: 'This version has nothing Draft Tide can preview (see details.reason). The version is fine.',
  PREVIEW_FAILED: 'The preview could not be made (see details.reason). The version is fine.',
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
    const id = envelope.error.details['operationId'];
    const ref = typeof id === 'string' ? `Operation: ${id}\n` : '';
    process.stderr.write(
      `draft-tide: ${envelope.error.message} (${envelope.error.code})\n${ref}${hint ? `${hint}\n` : ''}`,
    );
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
  if (s.recoveryRequired) lines.push('An earlier change stopped part-way: see `recover inspect`.');
  if (s.activeOperation) lines.push(`Busy: ${s.activeOperation.activity} (${s.activeOperation.origin}).`);
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

function versionText(v: VersionInfo): string {
  const label = v.seq !== null ? `V${v.seq}` : 'external change';
  return `${label} "${safe(v.title)}" (${v.snapshotId ?? v.commit})`;
}

function refText(r: CommitRef | null): string {
  return r ? (r.snapshotId ?? r.commit) : '—';
}

function renderRestorePlan(p: RestorePlan): string {
  const s = p.summary;
  const lines = [
    `Restore to ${versionText(p.target)}`,
    `Plan: ${p.planId} (valid until ${p.expiresAt})`,
    `Changes: ${s.overwrite} overwritten, ${s.add} added, ${s.delete} deleted, ${s.unchanged} unchanged`,
    p.protection.needed
      ? `Unsaved changes (${p.protection.unsavedChanges} files) are saved as a pre-restore version first.`
      : 'No unsaved changes: nothing needs protecting.',
  ];
  if (p.settings.action === 'kept') lines.push(`.drafttide.json stays as it is (${p.settings.reason ?? ''}).`);
  if (p.writers.recentlyModified.count > 0) {
    lines.push(
      `${p.writers.recentlyModified.count} file(s) changed in the last seconds: stop tools writing to the folder.`,
    );
  }
  for (const c of p.collisions.entries) lines.push(`In the way (${c.reason}): ${safe(c.path)}`);
  if (p.noop) lines.push('The folder already matches this version: applying changes nothing.');
  if (p.blocked) lines.push(`Applying would refuse now: ${p.blocked}`);
  let out = `${lines.join('\n')}\n`;
  const mark = { overwrite: 'M', add: 'A', delete: 'D' } as const;
  out += p.changes.map((c) => `  ${mark[c.change]}  ${safe(c.path)}\n`).join('');
  if (p.truncated) out += '  … (list cut short)\n';
  return out;
}

function renderRestoreResult(r: RestoreResult): string {
  return [
    `Restored ${refText(r.target)}: ${r.written} written, ${r.deleted} deleted.`,
    `Restore version: ${refText(r.restored)}`,
    r.protection
      ? `Earlier content saved as: ${refText(r.protection)} (pre-restore)`
      : 'No unsaved changes needed protecting.',
    '',
  ].join('\n');
}

function renderOperation(o: OperationStatus): string {
  const lines = [`${o.operationId}  ${o.kind}  ${o.state}  (${o.origin}, ${o.updatedAt})`];
  if (o.error) lines.push(`  ${o.error.code}: ${safe(o.error.message)}`);
  if (o.kind === 'save' && o.snapshot) lines.push(`  version: ${refText(o.snapshot)}`);
  if (o.kind === 'restore') {
    lines.push(`  target: ${refText(o.target)}`);
    if (o.protection) lines.push(`  pre-restore version: ${refText(o.protection)}`);
    if (o.restored) lines.push(`  restore version: ${refText(o.restored)}`);
    if (o.conflicts.count > 0)
      lines.push(`  left as other programs wrote them: ${o.conflicts.sample.map(safe).join(', ')}`);
  }
  if (o.kind === 'connect-request') {
    lines.push(`  folder: ${safe(o.request.root)}`);
    if (o.project) lines.push(`  connected as project ${o.project.projectId}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRecovery(r: RecoveryReport): string {
  if (r.items.length === 0) return `Nothing to recover (Git's index lock: ${r.lock}).\n`;
  return r.items
    .map((i) => {
      const lines = [
        `${i.operationId}  ${i.kind}  ${i.reason}${i.automatic ? '  (completed automatically before the next change)' : ''}`,
      ];
      if (i.files) {
        lines.push(
          `  files: ${i.files.done} done, ${i.files.pending} not yet, ${i.files.conflicts.count} changed by others`,
        );
      }
      lines.push(`  strategies: ${i.strategies.join(', ')}`);
      return `${lines.join('\n')}\n`;
    })
    .join('');
}

function renderRecoveryPlan(p: RecoveryPlan): string {
  return [
    `Recovery plan ${p.planId}: ${p.strategy} ${p.operationId}`,
    `Writes ${p.write}, deletes ${p.delete}, leaves ${p.unchanged} as they are; ${p.conflicts.count} changed by others stay untouched.`,
    p.records ? 'Records the restore version.' : 'Records no version.',
    '',
  ].join('\n');
}

function renderRecoveryResult(r: RecoveryResult): string {
  const head = r.operation ? renderOperation(r.operation) : "Draft Tide's lock was removed.\n";
  const conflicts =
    r.conflicts.count > 0 ? `Left as other programs wrote them: ${r.conflicts.sample.map(safe).join(', ')}\n` : '';
  return `${head}${r.written} written, ${r.deleted} deleted.\n${conflicts}`;
}

function renderCancel(r: OperationCancelResult): string {
  return `${r.outcome}\n${renderOperation(r.operation)}`;
}

type PreviewOutput = PreviewArtifact & { out?: { path: string; image: 'full' | 'thumbnail'; bytes: number } };

function renderPreview(p: PreviewOutput): string {
  const version = versionText(p.version);
  const what = p.subject.kind === 'page' ? `page ${safe(p.subject.path)}` : `image ${safe(p.subject.path)}`;
  const lines = [
    `Preview of ${version}: ${what}`,
    `  ${p.image.width}×${p.image.height} PNG (${p.image.bytes} bytes), thumbnail ${p.thumbnail.width}×${p.thumbnail.height}; rendered ${p.renderedAt}${p.cached ? ' (cached)' : ''}`,
  ];
  if (p.missing.count > 0) {
    lines.push(
      `  Missing (${p.missing.count}): ${p.missing.entries.map((m) => `${safe(m.path)} [${m.reason}]`).join(', ')}`,
    );
  }
  if (p.blocked.count > 0) {
    lines.push(
      `  Blocked (${p.blocked.count}): ${p.blocked.entries.map((b) => `${b.kind} ${safe(b.target)}`).join(', ')}`,
    );
  }
  const e = p.environment;
  lines.push(
    `  Renderer: ${safe(e.renderer)} on ${safe(e.platform)} ${safe(e.osRelease)}; ${p.settings.viewport.width}×${p.settings.viewport.height}, ${safe(p.settings.locale)}, ${safe(p.settings.timezone)}`,
    `  Artifact: ${p.artifactId} (readable until ${p.expiresAt})`,
  );
  if (p.out) lines.push(`  Written: ${safe(p.out.path)} (${p.out.image}, ${p.out.bytes} bytes)`);
  return `${lines.join('\n')}\n`;
}

// Reads the artifact's PNG in chunks and checks it against the artifact's
// hash before writing it (never over an existing file).
async function savePreview(
  conn: EngineConnection,
  art: PreviewArtifact,
  image: 'full' | 'thumbnail',
  out: string,
): Promise<PreviewOutput> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = (await conn.callRaw('preview.read', {
      projectId: art.projectId,
      artifactId: art.artifactId,
      image,
      offset,
    })) as PreviewChunk;
    const bytes = Buffer.from(chunk.data, 'base64');
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done || bytes.length === 0) break;
  }
  const png = Buffer.concat(parts);
  const want = image === 'full' ? art.image : art.thumbnail;
  if (createHash('sha256').update(png).digest('hex') !== want.sha256) {
    throw new DtError('PREVIEW_FAILED', 'the preview changed while it was read; ask for it again', {
      reason: 'invalid-output',
    });
  }
  const path = resolve(out);
  try {
    writeFileSync(path, png, { flag: 'wx' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') usage(`${out} already exists; choose another --out`);
    throw new DtError('INVALID_ARGUMENT', `cannot write ${out} (${code ?? 'error'})`, { reason: 'out-not-writable' });
  }
  return { ...art, out: { path, image, bytes: png.length } };
}

async function withEngine<T>(
  fn: (conn: EngineConnection) => Promise<T>,
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
    const c = conn;
    emit(okEnvelope(await fn(c)), render);
  } catch (e) {
    emit(errorEnvelope(e), render);
  } finally {
    conn?.close();
  }
}

function run<N extends OperationName>(
  op: N,
  payload: Record<string, unknown> | (() => Record<string, unknown>),
  render: (data: never) => string,
): Promise<void> {
  return withEngine((conn) => conn.callRaw(op, typeof payload === 'function' ? payload() : payload), render);
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
  .command('preview')
  .description(
    "A picture of a version: its entry page (or a PNG/JPEG with --file), rendered offline by Draft Tide's isolated Preview Host (needs --project)",
  )
  .argument('<version>', 'a snapshot id or commit id from `history`')
  .option('--file <path>', 'a PNG or JPEG of the version instead of its entry page')
  .option('--out <png>', 'write the PNG to this file (never overwrites one)')
  .option('--thumbnail', 'with --out: write the 400×250 thumbnail instead')
  .action((version: string, options: { file?: string; out?: string; thumbnail?: boolean }) =>
    withEngine(async (conn) => {
      if (options.thumbnail && options.out === undefined) usage('--thumbnail needs --out');
      const art = (await conn.callRaw('snapshot.preview', {
        projectId: requireProject(),
        version,
        ...(options.file !== undefined ? { file: options.file } : {}),
      })) as PreviewArtifact;
      if (options.out === undefined) return art;
      return savePreview(conn, art, options.thumbnail ? 'thumbnail' : 'full', options.out);
    }, renderPreview),
  );

const init = program.command('init').description('Connecting a design folder (done by the user in the app)');
init
  .command('request')
  .description('Ask the user to connect a folder in the Draft Tide app (answers CONFIRMATION_REQUIRED)')
  .requiredOption('--root <path>', 'the folder, as an absolute path')
  .option('--entry <file>', 'an entry page for previews (repeatable)', (v: string, all: string[]) => [...all, v], [])
  .option('--name <name>', 'a name for the project')
  .action((options: { root: string; entry: string[]; name?: string }) =>
    run(
      'project.connectRequest',
      {
        root: options.root,
        ...(options.entry.length > 0 ? { entryFiles: options.entry } : {}),
        ...(options.name !== undefined ? { name: options.name } : {}),
      },
      () => '',
    ),
  );

program
  .command('restore-settings')
  .description('Put a deleted .drafttide.json back from the newest version (needs --project)')
  .action(() =>
    run(
      'project.restoreSettings',
      () => ({ projectId: requireProject() }),
      (r: { from: string }) => `Settings file put back from ${r.from}.\n`,
    ),
  );

const restore = program.command('restore').description('Restoring a version: plan, then apply (needs --project)');
restore
  .command('plan')
  .description('What restoring a version would overwrite, add and delete; prints a plan id')
  .argument('<version>', 'a snapshot id or commit id from `history`')
  .action((version: string) =>
    run('restore.plan', () => ({ projectId: requireProject(), target: version }), renderRestorePlan),
  );
restore
  .command('apply')
  .description('Apply a restore plan: unsaved changes are saved as a pre-restore version first')
  .argument('<plan-id>', 'from `restore plan`')
  .action((planId: string) =>
    run('restore.apply', () => ({ projectId: requireProject(), planId }), renderRestoreResult),
  );

const recover = program.command('recover').description('Operations that stopped part-way (needs --project)');
recover
  .command('inspect')
  .description('What is left and how it can be completed (reads only)')
  .action(() => run('recovery.inspect', () => ({ projectId: requireProject() }), renderRecovery));
recover
  .command('plan')
  .description('Plan finishing or rolling back an operation; prints a plan id')
  .requiredOption('--strategy <strategy>', 'finish or rollback')
  .option('--operation <id>', 'the operation (needed when more than one is left)')
  .action((options: { strategy: string; operation?: string }) =>
    withEngine(async (conn) => {
      const projectId = requireProject();
      let operationId = options.operation;
      if (operationId === undefined) {
        const report = (await conn.callRaw('recovery.inspect', { projectId })) as RecoveryReport;
        const open = report.items.filter((i) => i.strategies.includes(options.strategy as 'finish' | 'rollback'));
        if (open.length !== 1) {
          usage(
            open.length === 0
              ? `no operation can be recovered with ${options.strategy}`
              : `more than one operation is left; pass --operation (${open.map((i) => i.operationId).join(', ')})`,
          );
        }
        operationId = open[0]?.operationId;
      }
      return conn.callRaw('recovery.plan', { projectId, operationId, strategy: options.strategy });
    }, renderRecoveryPlan),
  );
recover
  .command('apply')
  .description('Apply a recovery plan')
  .argument('<plan-id>', 'from `recover plan`')
  .action((planId: string) =>
    run('recovery.apply', () => ({ projectId: requireProject(), planId }), renderRecoveryResult),
  );

const operation = program.command('operation').description('Following an operation or a request');
operation
  .command('status')
  .description("An operation's state: a save, a restore, or a request waiting for the user")
  .argument('<operation-id>')
  .action((operationId: string) => run('operation.status', { operationId }, renderOperation));
operation
  .command('cancel')
  .description('Cancel at the next safe boundary, or withdraw a request')
  .argument('<operation-id>')
  .action((operationId: string) => run('operation.cancel', { operationId }, renderCancel));

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
