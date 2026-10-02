import { z } from 'zod';
import { AgentAccess, EngineInfo, ProjectSummary } from './engine.ts';
import {
  FileDiff,
  HistoryListInput,
  HistoryPage,
  SavedSnapshot,
  SnapshotCreateInput,
  SnapshotDiff,
  SnapshotDiffFileInput,
  SnapshotDiffInput,
} from './history.ts';
import {
  PreviewArtifact,
  PreviewCacheCleared,
  PreviewChunk,
  PreviewReadInput,
  PreviewStatus,
  SnapshotPreviewInput,
} from './preview.ts';
import {
  ConnectRequestInput,
  OperationCancelResult,
  OperationIdInput,
  OperationList,
  OperationStatus,
} from './operation.ts';
import {
  FolderReview,
  ProjectBindInput,
  ProjectBindResult,
  ProjectReviewInput,
  ProjectStatus,
  ProjectStatusInput,
  SettingsRestored,
} from './project.ts';
import {
  PlanApplyInput,
  RecoveryInspectInput,
  RecoveryPlan,
  RecoveryPlanInput,
  RecoveryReport,
  RecoveryResult,
  RestorePlan,
  RestorePlanInput,
  RestoreResult,
} from './restore.ts';

// The one list of Engine operations. The Engine dispatches from it, the
// policy in core authorizes from it, the CLI and MCP server are generated from
// it, and the GUI's typed bridge reads its types.
//
// tool: what the tool channel (CLI and MCP, treated the same) may do.
//   always        even with agent access off (only engine.info, M1 plan §9.1)
//   agent-access  only while the GUI's agent-access switch is on
//   none          not offered on the tool channel at all
// effect: drives MCP tool annotations. `destructive` means it can overwrite or
//   delete working files (restore, pull, recovery apply).
export type ToolAccess = 'always' | 'agent-access' | 'none';
export type OperationEffect = 'read' | 'write' | 'destructive';

export interface OperationSpec {
  summary: string;
  input: z.ZodType;
  output: z.ZodType;
  desktop: boolean;
  tool: ToolAccess;
  effect: OperationEffect;
}

const NoInput = z.strictObject({});

export const OPERATIONS = {
  'engine.info': {
    summary: 'Engine identity and versions, and whether agent access is on.',
    input: NoInput,
    output: EngineInfo,
    desktop: true,
    tool: 'always',
    effect: 'read',
  },
  'project.list': {
    summary: 'Design folders connected to Draft Tide on this computer.',
    input: NoInput,
    output: z.array(ProjectSummary),
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  // Connecting a folder grants Draft Tide that folder: only the trusted GUI,
  // from a folder the user picked (M1 plan §6.2, §9.1). The tool channel can
  // only ask (project.connectRequest).
  'project.review': {
    summary: 'Review a folder before connecting it: repo form, what would be saved, settings.',
    input: ProjectReviewInput,
    output: FolderReview,
    desktop: true,
    tool: 'none',
    effect: 'read',
  },
  'project.bind': {
    summary: 'Connect a reviewed folder: git init if needed, write .drafttide.json, record the binding.',
    input: ProjectBindInput,
    output: ProjectBindResult,
    desktop: true,
    tool: 'none',
    effect: 'write',
  },
  'project.status': {
    summary: "A connected project's folder, repo state and unsaved changes since the newest version.",
    input: ProjectStatusInput,
    output: ProjectStatus,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'project.restoreSettings': {
    summary:
      'Put .drafttide.json back from the newest version when it is missing from the folder (nothing is overwritten).',
    input: ProjectStatusInput,
    output: SettingsRestored,
    desktop: true,
    tool: 'agent-access',
    effect: 'write',
  },
  'snapshot.create': {
    summary: 'Save a version of the project folder (NO_CHANGES when nothing changed).',
    input: SnapshotCreateInput,
    output: SavedSnapshot,
    desktop: true,
    tool: 'agent-access',
    effect: 'write',
  },
  'history.list': {
    summary: "The project's versions and other tools' commits, newest first.",
    input: HistoryListInput,
    output: HistoryPage,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'snapshot.diff': {
    summary: 'Files added, modified, deleted or renamed between two versions.',
    input: SnapshotDiffInput,
    output: SnapshotDiff,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'snapshot.diffFile': {
    summary: 'Line-by-line changes of one file between two versions (text files within the diff budget).',
    input: SnapshotDiffFileInput,
    output: FileDiff,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  // Previews (M1 plan §8): rendered by the isolated Preview Host, kept in a
  // rebuildable cache. The tool channel gets the same artifact reference as
  // the app: bound to the project, short-lived, never a path.
  'snapshot.preview': {
    summary:
      "A picture of a version: its entry page (or one of its PNG/JPEG files) rendered offline at 1280×800 by the isolated Preview Host. Returns an artifact; read its PNG with preview.read. Lists what the page asked for and didn't get (missing, blocked).",
    input: SnapshotPreviewInput,
    output: PreviewArtifact,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'preview.read': {
    summary:
      "Part of a preview artifact's PNG (full or thumbnail), base64, from offset. Artifacts expire after 30 minutes.",
    input: PreviewReadInput,
    output: PreviewChunk,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'preview.status': {
    summary: 'Whether this Engine can render previews, with what settings, and how much the preview cache holds.',
    input: NoInput,
    output: PreviewStatus,
    desktop: true,
    tool: 'none',
    effect: 'read',
  },
  'preview.clearCache': {
    summary: 'Remove every cached preview (they are rebuilt when needed).',
    input: NoInput,
    output: PreviewCacheCleared,
    desktop: true,
    tool: 'none',
    effect: 'write',
  },
  // Restore and recovery write working files: plan, then apply (M1 plan
  // §9.2–9.4). The tool channel applies directly while agent access is on;
  // the app confirms first.
  'restore.plan': {
    summary:
      'Plan restoring the folder to a version: what would be overwritten, added and deleted, and whether unsaved changes are saved first.',
    input: RestorePlanInput,
    output: RestorePlan,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'restore.apply': {
    summary:
      'Apply a restore plan: unsaved changes become a pre-restore version, the files are written, a restore version is recorded. History is only added to. PLAN_STALE if the folder changed since the plan.',
    input: PlanApplyInput,
    output: RestoreResult,
    desktop: true,
    tool: 'agent-access',
    effect: 'destructive',
  },
  'recovery.inspect': {
    summary: 'Operations of a project that stopped part-way, what each left behind, and how it can be completed.',
    input: RecoveryInspectInput,
    output: RecoveryReport,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'recovery.plan': {
    summary:
      'Plan finishing or rolling back an operation that stopped part-way; files changed by others are left alone.',
    input: RecoveryPlanInput,
    output: RecoveryPlan,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'recovery.apply': {
    summary: 'Apply a recovery plan. PLAN_STALE if the folder changed since the plan.',
    input: PlanApplyInput,
    output: RecoveryResult,
    desktop: true,
    tool: 'agent-access',
    effect: 'destructive',
  },
  'operation.status': {
    summary: "An operation's state: a save, a restore, or a request waiting for the user in the app.",
    input: OperationIdInput,
    output: OperationStatus,
    desktop: true,
    tool: 'agent-access',
    effect: 'read',
  },
  'operation.cancel': {
    summary:
      'Cancel an operation at its next safe boundary, or withdraw a request. One that is already writing files finishes.',
    input: OperationIdInput,
    output: OperationCancelResult,
    desktop: true,
    tool: 'agent-access',
    effect: 'write',
  },
  // Only the user connects folders. This always answers CONFIRMATION_REQUIRED
  // with an operation id; the app shows the request.
  'project.connectRequest': {
    summary:
      'Ask the user to connect a folder in the Draft Tide app. Answers CONFIRMATION_REQUIRED with an operation id; follow it with operation.status.',
    input: ConnectRequestInput,
    output: z.never(),
    desktop: false,
    tool: 'agent-access',
    effect: 'write',
  },
  'operation.list': {
    summary: 'Agent requests waiting for the user, agent restores not yet dismissed, operations needing recovery.',
    input: NoInput,
    output: OperationList,
    desktop: true,
    tool: 'none',
    effect: 'read',
  },
  'request.decline': {
    summary: 'Decline an agent request (APPROVAL_DENIED for the agent).',
    input: OperationIdInput,
    output: OperationStatus,
    desktop: true,
    tool: 'none',
    effect: 'write',
  },
  'operation.dismiss': {
    summary: 'Dismiss the notice of an agent restore.',
    input: OperationIdInput,
    output: OperationStatus,
    desktop: true,
    tool: 'none',
    effect: 'write',
  },
  'agentAccess.get': {
    summary: 'Whether external agents may use Draft Tide through the CLI and MCP.',
    input: NoInput,
    output: AgentAccess,
    desktop: true,
    tool: 'none',
    effect: 'read',
  },
  'agentAccess.set': {
    summary: 'Turn agent access (CLI and MCP together) on or off.',
    input: z.strictObject({ enabled: z.boolean() }),
    output: AgentAccess,
    desktop: true,
    tool: 'none',
    effect: 'write',
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;
export type OperationInput<N extends OperationName> = z.input<(typeof OPERATIONS)[N]['input']>;
export type OperationParsedInput<N extends OperationName> = z.output<(typeof OPERATIONS)[N]['input']>;
export type OperationOutput<N extends OperationName> = z.output<(typeof OPERATIONS)[N]['output']>;

export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];

export function isOperationName(op: string): op is OperationName {
  return Object.hasOwn(OPERATIONS, op);
}

export function operationSpec(op: OperationName): OperationSpec {
  return OPERATIONS[op];
}

export type DesktopOperationName = {
  [N in OperationName]: (typeof OPERATIONS)[N]['desktop'] extends true ? N : never;
}[OperationName];

export type ToolOperationName = {
  [N in OperationName]: (typeof OPERATIONS)[N]['tool'] extends 'none' ? never : N;
}[OperationName];

export function isOfferedOn(op: OperationName, channel: 'desktop' | 'tool'): boolean {
  const spec = operationSpec(op);
  return channel === 'desktop' ? spec.desktop : spec.tool !== 'none';
}
