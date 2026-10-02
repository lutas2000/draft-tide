// Local stdio MCP server. stdout carries MCP protocol only; diagnostics go to
// stderr. Tools are generated from the operation catalog and forward to the
// same Engine as the GUI, so access rules and results are identical.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  DtError,
  OPERATIONS,
  OPERATION_NAMES,
  errorEnvelope,
  isMcpError,
  okEnvelope,
  type Envelope,
  type OperationName,
  type OperationSpec,
} from '@draft-tide/contracts';
import { connectEngine, type EngineConnection } from '@draft-tide/engine-client';
import type { z } from 'zod';
import { BUILD } from '../build-info.ts';
import { engineLaunch } from '../engine-launch.ts';

const INSTRUCTIONS = `Draft Tide keeps version history for a designer's local design folders.
Every tool returns one JSON envelope: {schemaVersion, ok, data, warnings, error: {code, message, details, retryable}}.
Call engine_info first. If agentAccess.enabled is false, every other tool returns AGENT_ACCESS_DISABLED:
ask the user to turn on agent access in the Draft Tide app (Settings). You cannot turn it on yourself.
Use project_list to find the project the user means; never guess a folder. Only the user connects a new folder:
project_connect_request asks them in the app and answers CONFIRMATION_REQUIRED with details.operationId; follow it
with operation_status until it is completed (the project is in the result), denied or cancelled.
project_status shows unsaved changes; stop writing files before snapshot_create.
snapshot_create answers NO_CHANGES (not an error) when the folder equals the newest version.
history_list gives snapshot ids (permanent) and commit ids; snapshot_diff and snapshot_diff_file compare two of them.
snapshot_preview renders a version's entry page (or one of its PNG/JPEG files) offline, with the network blocked,
and returns an artifact: its missing and blocked lists say what the page asked for and didn't get, so the picture
may differ from what the designer sees online. Read the PNG with preview_read (base64 chunks, until done).
PREVIEW_UNSUPPORTED and PREVIEW_FAILED are about the preview only; the version itself is fine.
To restore a version: stop your own writes to the folder, call restore_plan, read its summary, then restore_apply
with its planId. Unsaved changes are saved as a pre-restore version first; tell the user which version that is.
PLAN_STALE means files changed since the plan: plan again. UNTRACKED_FILES means files no version holds are in the way.
RECOVERY_REQUIRED means an earlier change stopped part-way: recovery_inspect, then recovery_plan and recovery_apply.
GitHub: you never handle a token, and only the user signs in (auth_login_request asks them) and connects a repository
(remote_connect_request). remote_status says whether a project is synced. Once the user connected it, versions are
pushed in the background after each save; sync_push pushes now. To get newer versions from GitHub, call
sync_pull_plan, then sync_pull_apply: it only fast-forwards, and refuses with UNSAVED_CHANGES (save first).
REMOTE_DIVERGED means GitHub and the folder both have new versions: nothing was changed; never try to merge or force,
tell the user. remote_open_plan and remote_open_apply open a project from GitHub into a folder that doesn't exist yet
or is empty. AUTH_REQUIRED and NETWORK_UNAVAILABLE never affect anything local.
Report error codes to the user as they are; do not describe a failure or a warning as success.`;

// engine.info → engine_info, snapshot.diffFile → snapshot_diff_file.
export function toolName(op: OperationName): string {
  return op.replace(/\./g, '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export async function serveMcp(options: { dataDir?: string }): Promise<void> {
  let conn: EngineConnection | null = null;
  const engine = async (): Promise<EngineConnection> => {
    if (conn && !conn.closed) return conn;
    conn = await connectEngine({
      channel: 'mcp',
      client: { name: 'draft-tide-mcp', version: BUILD.appVersion },
      launch: engineLaunch(),
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    });
    return conn;
  };

  const server = new McpServer({ name: 'draft-tide', version: BUILD.appVersion }, { instructions: INSTRUCTIONS });

  for (const op of OPERATION_NAMES) {
    const spec: OperationSpec = OPERATIONS[op];
    if (spec.tool === 'none') continue;
    const description =
      spec.tool === 'agent-access'
        ? `${spec.summary} Needs agent access to be on in the Draft Tide app.`
        : spec.summary;
    server.registerTool(
      toolName(op),
      {
        title: op,
        description,
        inputSchema: (spec.input as z.ZodObject).shape,
        annotations: {
          readOnlyHint: spec.effect === 'read',
          destructiveHint: spec.effect === 'destructive',
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        let envelope: Envelope<unknown>;
        try {
          envelope = okEnvelope(await (await engine()).callRaw(op, args));
        } catch (e) {
          envelope = errorEnvelope(e instanceof DtError || e instanceof Error ? e : new Error(String(e)));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], isError: isMcpError(envelope) };
      },
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[draft-tide mcp] ready on stdio (${BUILD.appVersion})\n`);
}
