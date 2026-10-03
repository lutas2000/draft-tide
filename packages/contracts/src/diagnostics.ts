import { z } from 'zod';
import { DesktopIdentityMode } from './engine.ts';
import { ErrorCodeSchema } from './errors.ts';
import { IsoTimestamp, ProjectId } from './ids.ts';
import { OperationKind, OperationState } from './operation.ts';
import { FolderState, ProjectName } from './project.ts';
import { AUTH_UNAVAILABLE_REASONS, AuthState, RepoVisibility, SyncState } from './remote.ts';
import { Origin } from './snapshot.ts';

// 設定與診斷 (M1 plan §4.1): how much room Draft Tide takes and has, and a
// diagnostics report the user can save and send. Both are for the app only.

const Count = z.number().int().nonnegative();

// ---- Storage use

// The data directory by part:
//   database  state.sqlite and its WAL: bindings, plans, the journal, the
//             sync queue (local state, never a cache)
//   staging   projects/<id>/operations: what running or unfinished
//             operations captured; removed when they end
//   previews  projects/<id>/cache: the rebuildable preview cache
//   logs      diagnostics/: the Engine's log
//   desktop   desktop/: the app's Chromium profile
//   other     everything else (Git's empty home, network scratch
//             directories, the runtime directory)
export const DATA_STORE_PARTS = ['database', 'staging', 'previews', 'logs', 'desktop', 'other'] as const;
export type DataStorePart = (typeof DATA_STORE_PARTS)[number];

export const DataStoreUsage = z.strictObject({
  parts: z.strictObject({
    database: Count,
    staging: Count,
    previews: Count,
    logs: Count,
    desktop: Count,
    other: Count,
  }),
  total: Count,
  // Free space on its volume, as an unprivileged user sees it; null when it
  // can't be read.
  availableBytes: Count.nullable(),
  // false: the walk stopped at its budget, so the sizes are lower bounds.
  complete: z.boolean(),
});
export type DataStoreUsage = z.infer<typeof DataStoreUsage>;

export const ProjectUsage = z.strictObject({
  projectId: ProjectId,
  name: ProjectName,
  // The project's history: the objects in its `.git`, loose and packed. null
  // when the folder or its history can't be read.
  historyBytes: Count.nullable(),
  // Free space where new versions are written (the volume of its `.git`).
  availableBytes: Count.nullable(),
  // On the same volume as the data directory (their free space is shared).
  sameVolumeAsDataStore: z.boolean().nullable(),
});
export type ProjectUsage = z.infer<typeof ProjectUsage>;

export const StorageUsage = z.strictObject({
  dataStore: DataStoreUsage,
  projects: z.array(ProjectUsage).max(1000),
  measuredAt: IsoTimestamp,
});
export type StorageUsage = z.infer<typeof StorageUsage>;

// ---- The diagnostics report
//
// De-identified (M1 plan §4.1, §10.1): this schema is the boundary. It holds
// no file contents, file or folder names, paths, project names, GitHub
// accounts or repositories, commit messages, tokens or ids that also appear
// in a project's history (snapshot, operation and project ids are in commit
// metadata, which may be public). Projects and operations are labels
// (project-1, id-3) that only mean something inside one report. The only
// free text is the end of the Engine's log, with the paths, names, ids and
// accounts the Engine knows replaced by the same labels before it leaves the
// Engine; the app shows the report before the user sends it anywhere.

export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_LOG_MAX_CHARS = 256 * 1024;

// A label standing for a project or an id within one report.
export const DiagnosticsLabel = z.string().regex(/^(?:project|id)-[1-9][0-9]{0,5}$/);
// Stable reasons are short kebab-case words; anything else is left out.
export const DiagnosticsReason = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const Problem = z.strictObject({ code: ErrorCodeSchema, reason: DiagnosticsReason.nullable() });

export const DiagnosticsProject = z.strictObject({
  label: DiagnosticsLabel,
  // null when the check itself failed (checkError says how).
  folder: FolderState.nullable(),
  checkError: Problem.nullable(),
  blockers: z.array(z.strictObject({ code: ErrorCodeSchema, reason: DiagnosticsReason })).max(64),
  recoveryRequired: z.boolean(),
  hasVersions: z.boolean(),
  historyBytes: Count.nullable(),
  availableBytes: Count.nullable(),
  sameVolumeAsDataStore: z.boolean().nullable(),
  // null: not connected to a GitHub repository.
  sync: z
    .strictObject({
      // null when it couldn't be read.
      state: SyncState.nullable(),
      visibility: RepoVisibility,
      ahead: Count.nullable(),
      behind: Count.nullable(),
      lastError: Problem.nullable(),
      queuedPushAttempts: Count.nullable(),
    })
    .nullable(),
});
export type DiagnosticsProject = z.infer<typeof DiagnosticsProject>;

export const DiagnosticsOperation = z.strictObject({
  label: DiagnosticsLabel,
  kind: OperationKind,
  state: OperationState,
  origin: Origin,
  project: DiagnosticsLabel.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  error: ErrorCodeSchema.nullable(),
});
export type DiagnosticsOperation = z.infer<typeof DiagnosticsOperation>;

export const DiagnosticsReport = z.strictObject({
  kind: z.literal('draft-tide-diagnostics'),
  schemaVersion: z.literal(DIAGNOSTICS_SCHEMA_VERSION),
  createdAt: IsoTimestamp,
  app: z.strictObject({
    version: z.string().max(64),
    protocolVersion: z.number().int().positive(),
    storageSchemaVersion: Count,
    desktopIdentity: DesktopIdentityMode,
    engineStartedAt: IsoTimestamp,
    runtime: z.strictObject({
      node: z.string().max(64),
      sqlite: z.string().max(64),
      platform: z.string().max(32),
      arch: z.string().max(32),
      osRelease: z.string().max(64),
      // The Git the Engine runs (its version), or null when it has none.
      git: z.string().max(64).nullable(),
    }),
  }),
  agentAccess: z.strictObject({ enabled: z.boolean() }),
  github: z.strictObject({ state: AuthState, unavailableReason: z.enum(AUTH_UNAVAILABLE_REASONS).nullable() }),
  previews: z.strictObject({
    available: z.boolean(),
    renderer: z.string().max(128).nullable(),
    entries: Count,
    bytes: Count,
  }),
  dataStore: DataStoreUsage,
  projects: z.array(DiagnosticsProject).max(1000),
  operations: z.strictObject({
    // Running, stopped part-way, or waiting for the user (at most 100).
    open: z.array(DiagnosticsOperation).max(100),
    // Everything else the journal keeps (30 days), counted.
    ended: z
      .array(
        z.strictObject({ kind: OperationKind, state: OperationState, error: ErrorCodeSchema.nullable(), count: Count }),
      )
      .max(1000),
    // The journal couldn't be read (the lists are then empty).
    readError: Problem.nullable(),
  }),
  log: z.strictObject({
    // The end of the Engine's log, whole lines, de-identified.
    text: z.string().max(DIAGNOSTICS_LOG_MAX_CHARS),
    // Older lines were left out.
    truncated: z.boolean(),
  }),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReport>;
