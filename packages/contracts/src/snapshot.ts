import { z } from 'zod';
import { IsoTimestamp, OperationId, SnapshotId } from './ids.ts';
import { isSingleLine } from './text.ts';

// Metadata stored as canonical JSON in each Draft Tide commit message (M1 plan
// §5.2). Entry files and excludes are not repeated here: every commit's tree
// carries its own `.drafttide.json`. Never add absolute paths, prompts,
// credentials, tokens or approval data.
export const SNAPSHOT_METADATA_SCHEMA_VERSION = 1;

export const SNAPSHOT_KINDS = ['baseline', 'manual', 'agent-requested', 'pre-restore', 'restore'] as const;
export const SnapshotKind = z.enum(SNAPSHOT_KINDS);
export type SnapshotKind = z.infer<typeof SnapshotKind>;

// Which entry point asked. `agent-requested` (a kind) does not prove an agent
// task succeeded, and origin says nothing about who is on the other end.
export const ORIGINS = ['gui', 'cli', 'mcp'] as const;
export const Origin = z.enum(ORIGINS);
export type Origin = z.infer<typeof Origin>;

export const SnapshotName = z.string().max(200).refine(isSingleLine, 'must be a single line');

export const SnapshotMetadata = z.strictObject({
  schemaVersion: z.literal(SNAPSHOT_METADATA_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  kind: SnapshotKind,
  createdAt: IsoTimestamp,
  origin: Origin,
  name: SnapshotName.optional(),
  restoreOf: SnapshotId.optional(),
  operationId: OperationId.optional(),
});
export type SnapshotMetadata = z.infer<typeof SnapshotMetadata>;
