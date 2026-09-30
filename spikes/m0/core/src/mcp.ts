// Local stdio MCP server. stdout carries MCP protocol only; everything else
// goes to stderr. Every tool is a thin call into the same Engine as the GUI.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectEngine, type EngineConnection } from './engine/client.ts';
import { errorEnvelope, okEnvelope } from './shared/errors.ts';

const INSTRUCTIONS = `Draft Tide keeps version history for a designer's local design folder.
Use project_list to find the project the user means; never guess a folder.
Save with snapshot_create after the files you changed are fully written.
Restores overwrite working files: call restore_plan, then operation_request_approval,
then tell the user to confirm in the Draft Tide app. Poll operation_status and call
restore_apply only after it reports approved. You cannot approve on the user's behalf.
Every result is a JSON envelope {ok, data, warnings, error{code,message}}; report
error codes such as PLAN_STALE or APPROVAL_DENIED to the user as they are.`;

export async function serveMcp(opts: { dataDir?: string }): Promise<void> {
  let conn: EngineConnection | null = null;
  const engine = async (): Promise<EngineConnection> => {
    if (!conn) {
      const c = await connectEngine(opts.dataDir ? { client: 'mcp', dataDir: opts.dataDir } : { client: 'mcp' });
      conn = c;
    }
    return conn;
  };
  const call = async (op: string, payload: Record<string, unknown> = {}) => {
    let env;
    try {
      env = okEnvelope(await (await engine()).call(op, payload));
    } catch (e) {
      env = errorEnvelope(e);
      if (env.error?.code === 'LOCKED') conn = null; // reconnect next time
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(env) }], isError: !env.ok };
  };

  const server = new McpServer({ name: 'draft-tide', version: '0.0.0-m0' }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: false };
  const projectId = z.string().uuid().describe('Draft Tide project id from project_list');

  server.registerTool('project_list', { title: 'List projects', description: 'List design folders the user has connected to Draft Tide.', annotations: ro }, () => call('project.list'));
  server.registerTool('project_status', { title: 'Project status', description: 'Latest version, unsaved changes and pending operations for one project.', inputSchema: { projectId }, annotations: ro }, (a) => call('project.status', a));
  server.registerTool(
    'snapshot_create',
    {
      title: 'Save version',
      description: 'Save the current files of the project as a new version. Returns NO_CHANGES if nothing changed. Only call after your edits are fully written to disk.',
      inputSchema: { projectId, name: z.string().max(200).optional().describe('Short version name shown to the designer') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => call('snapshot.create', a),
  );
  server.registerTool('history_list', { title: 'Version history', description: 'Saved versions, newest first. Use snapshotId (not V-numbers) to refer to a version.', inputSchema: { projectId }, annotations: ro }, (a) => call('history.list', a));
  server.registerTool(
    'restore_plan',
    { title: 'Plan restore', description: 'Compute what restoring a version would overwrite, add and delete. Writes nothing. Returns an operationId.', inputSchema: { projectId, snapshotId: z.string().uuid() }, annotations: ro },
    (a) => call('restore.plan', a),
  );
  server.registerTool(
    'operation_request_approval',
    { title: 'Ask the user to confirm', description: 'Ask the designer to confirm a planned restore in the Draft Tide app. Always returns CONFIRMATION_REQUIRED; the user decides in the app.', inputSchema: { operationId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    (a) => call('operation.requestApproval', a),
  );
  server.registerTool('operation_status', { title: 'Operation status', description: 'State of a planned operation: planned, awaiting-approval, approved, denied, applying, completed, failed.', inputSchema: { operationId: z.string().uuid() }, annotations: ro }, (a) => call('operation.status', a));
  server.registerTool(
    'restore_apply',
    { title: 'Apply approved restore', description: 'Apply a restore the designer has approved in the Draft Tide app. Unsaved work is saved first as a protection version. Fails with CONFIRMATION_REQUIRED, APPROVAL_DENIED or PLAN_STALE otherwise.', inputSchema: { operationId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
    (a) => call('restore.apply', a),
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write('[draft-tide mcp] ready on stdio\n');
}
