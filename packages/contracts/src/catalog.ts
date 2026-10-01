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
  FolderReview,
  ProjectBindInput,
  ProjectBindResult,
  ProjectReviewInput,
  ProjectStatus,
  ProjectStatusInput,
} from './project.ts';

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
  // from a folder the user picked (M1 plan §6.2, §9.1). The tool channel's
  // request flow arrives with M1-05.
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
