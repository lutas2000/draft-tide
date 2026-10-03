// Local stdio MCP server. stdout carries MCP protocol only; diagnostics go to
// stderr. Tools are generated from the operation catalog and forward to the
// same Engine as the GUI, so access rules and results are identical. The one
// addition is MCP's own: snapshot_preview attaches the picture as image
// content (M1 plan §11.2), read from the Engine in chunks and checked against
// the artifact's hash.
import { createHash } from 'node:crypto';
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
  type PreviewArtifact,
  type PreviewChunk,
  type PreviewImageKind,
  type Warning,
} from '@draft-tide/contracts';
import { connectEngine, type EngineConnection } from '@draft-tide/engine-client';
import { z } from 'zod';
import { BUILD } from '../build-info.ts';
import { engineLaunch } from '../engine-launch.ts';

const INSTRUCTIONS = `Draft Tide keeps version history for a designer's local design folders.
Every tool returns one JSON envelope: {schemaVersion, ok, data, warnings, error: {code, message, details, retryable}}.
Call engine_info first. If agentAccess.enabled is false, every other tool returns AGENT_ACCESS_DISABLED:
ask the user to turn on agent access in the Draft Tide app (設定與診斷 / Settings). You cannot turn it on yourself.
Use project_list to find the project the user means; never guess a folder. Only the user connects a new folder:
project_connect_request asks them in the app and answers CONFIRMATION_REQUIRED with details.operationId; follow it
with operation_status until it is completed (the project is in the result), denied or cancelled. details.app says
whether the app came forward (shown), is opening (opening), or the user must open it (unavailable).
project_status shows unsaved changes; stop writing files before snapshot_create.
snapshot_create answers NO_CHANGES (not an error) when the folder equals the newest version.
history_list gives snapshot ids (permanent) and commit ids; snapshot_diff and snapshot_diff_file compare two of them.
snapshot_preview renders a version's entry page (or one of its PNG/JPEG files) offline, with the network blocked.
Its result is the artifact (text) followed by the picture as image content (the full 1280×800 PNG by default;
pass image: "thumbnail" for a small one, or image: "none" for the artifact only). The artifact's missing and blocked
lists say what the page asked for and didn't get, so the picture may differ from what the designer sees online.
preview_read returns the PNG bytes in base64 chunks for hosts that need the file. PREVIEW_UNSUPPORTED and
PREVIEW_FAILED are about the preview only; the version itself is fine.
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

// Which picture snapshot_preview attaches. MCP's own field: it never reaches
// the Engine.
export const PREVIEW_IMAGE_CHOICES = ['full', 'thumbnail', 'none'] as const;
export const PreviewImageChoice = z.enum(PREVIEW_IMAGE_CHOICES);
export type PreviewImageChoice = z.infer<typeof PreviewImageChoice>;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

// The host validates arguments against this before the handler runs. Unknown
// fields pass through to the Engine, whose strict schema refuses them with
// INVALID_ARGUMENT in the envelope: a self-asserted `confirmed: true` is
// reported, never silently dropped.
function inputFor(spec: OperationSpec, extra: z.ZodRawShape = {}) {
  return z.looseObject({ ...(spec.input as z.ZodObject).shape, ...extra });
}

// Reads an artifact's PNG in chunks and checks it against the artifact's
// hash, like the CLI's --out does.
export async function readPreviewPng(
  conn: EngineConnection,
  art: PreviewArtifact,
  image: PreviewImageKind,
): Promise<Buffer> {
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
  return png;
}

function toolResult(envelope: Envelope<unknown>, extra: Content[] = []) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }, ...extra],
    isError: isMcpError(envelope),
  };
}

function failure(e: unknown): Envelope<never> {
  return errorEnvelope(e instanceof DtError || e instanceof Error ? e : new Error(String(e)));
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
    const access = spec.tool === 'agent-access' ? ' Needs agent access to be on in the Draft Tide app.' : '';
    const annotations = {
      readOnlyHint: spec.effect === 'read',
      destructiveHint: spec.effect === 'destructive',
      openWorldHint: false,
    };
    if (op === 'snapshot.preview') {
      server.registerTool(
        toolName(op),
        {
          title: op,
          description: `${spec.summary} The picture follows the artifact as image content (full by default, or thumbnail; none for the artifact only).${access}`,
          inputSchema: inputFor(spec, { image: PreviewImageChoice.optional() }),
          annotations,
        },
        async ({ image, ...args }: { image?: PreviewImageChoice | undefined } & Record<string, unknown>) => {
          let art: PreviewArtifact;
          try {
            art = (await (await engine()).callRaw(op, args)) as PreviewArtifact;
          } catch (e) {
            return toolResult(failure(e));
          }
          const choice = image ?? 'full';
          if (choice === 'none') return toolResult(okEnvelope(art));
          // The artifact stands on its own: a picture that can't be read is a
          // warning, not a failed tool.
          try {
            const png = await readPreviewPng(await engine(), art, choice);
            return toolResult(okEnvelope(art), [
              { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            ]);
          } catch (e) {
            const warning: Warning = {
              code: 'PREVIEW_IMAGE_UNAVAILABLE',
              message: `the picture could not be attached (${e instanceof DtError ? e.code : 'error'}): read it with preview_read`,
            };
            return toolResult(okEnvelope(art, [warning]));
          }
        },
      );
      continue;
    }
    server.registerTool(
      toolName(op),
      {
        title: op,
        description: `${spec.summary}${access}`,
        inputSchema: inputFor(spec),
        annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          return toolResult(okEnvelope(await (await engine()).callRaw(op, args)));
        } catch (e) {
          return toolResult(failure(e));
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[draft-tide mcp] ready on stdio (${BUILD.appVersion})\n`);
}
