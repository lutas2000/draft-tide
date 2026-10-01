import { z } from 'zod';

// Lowercase RFC 4122 UUIDs, the form crypto.randomUUID() produces. One
// canonical spelling, so IDs compare as plain strings everywhere: SQLite keys,
// commit metadata, CLI arguments.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const uuid = () => z.string().regex(UUID_PATTERN, 'must be a lowercase UUID');

// Branded so a snapshot ID can't be passed where a project ID is expected.
export const ProjectId = uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;

export const SnapshotId = uuid().brand<'SnapshotId'>();
export type SnapshotId = z.infer<typeof SnapshotId>;

export const PlanId = uuid().brand<'PlanId'>();
export type PlanId = z.infer<typeof PlanId>;

export const OperationId = uuid().brand<'OperationId'>();
export type OperationId = z.infer<typeof OperationId>;

export const ArtifactId = uuid().brand<'ArtifactId'>();
export type ArtifactId = z.infer<typeof ArtifactId>;

// One running Engine process. Changes on every Engine start.
export const EngineInstanceId = uuid().brand<'EngineInstanceId'>();
export type EngineInstanceId = z.infer<typeof EngineInstanceId>;

export const RequestId = uuid().brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestId>;

// Machine timestamps are UTC ISO 8601 with milliseconds (Date#toISOString).
// Display code may localize them; nothing else may.
export const IsoTimestamp = z.iso.datetime({ offset: false, local: false, precision: 3 });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;
