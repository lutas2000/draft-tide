import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import { DtError } from './errors.ts';
import { IsoTimestamp, OperationId, SnapshotId } from './ids.ts';
import { CAPTURE_STAGES, CaptureProgress } from './scope.ts';
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

// ---- The commit message
//
//   <title: the save name, or a fixed title for the kind>
//
//   Draft-Tide-Snapshot: <canonical JSON metadata>
//
// The metadata line is the last line, after a blank line, so it never mixes
// with the user's text. Commit messages are untrusted on the way back in
// (anyone can write one, and remotes change), so reading is strict: the line
// must be canonical JSON within the size limit and match the schema exactly.

export const SNAPSHOT_METADATA_KEY = 'Draft-Tide-Snapshot';
export const MAX_SNAPSHOT_METADATA_BYTES = 4096;

const PREFIX = `${SNAPSHOT_METADATA_KEY}: `;

// For engineers reading the repo with plain Git or on GitHub; the GUI shows
// its own wording.
const KIND_TITLES: Record<SnapshotKind, string> = {
  baseline: 'Baseline',
  manual: 'Saved version',
  'agent-requested': 'Saved version (agent request)',
  'pre-restore': 'Before restore',
  restore: 'Restored version',
};

export function formatCommitMessage(metadata: SnapshotMetadata): string {
  const parsed = SnapshotMetadata.safeParse(metadata);
  if (!parsed.success) throw new DtError('INTERNAL_ERROR', 'snapshot metadata outside its contract');
  const json = canonicalJson(parsed.data);
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_METADATA_BYTES) {
    throw new DtError('INTERNAL_ERROR', 'snapshot metadata is too large');
  }
  const title = parsed.data.name?.trim() || KIND_TITLES[parsed.data.kind];
  return `${title}\n\n${PREFIX}${json}\n`;
}

export type CommitMetadataRead =
  | { status: 'snapshot'; metadata: SnapshotMetadata }
  // No metadata line: a commit made by another tool (an engineer, an agent's
  // own `git commit`). Still history; the GUI shows it as an external change.
  | { status: 'external' }
  // A metadata line that can't be trusted, or one from a newer Draft Tide.
  | { status: 'unreadable'; reason: 'invalid' | 'newer-schema' };

export function readCommitMetadata(message: string): CommitMetadataRead {
  const lines = message.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const last = lines.at(-1);
  if (last === undefined || !last.startsWith(PREFIX)) return { status: 'external' };
  const invalid = { status: 'unreadable', reason: 'invalid' } as const;
  if (lines.length < 3 || lines.at(-2) !== '') return invalid;
  const json = last.slice(PREFIX.length);
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_METADATA_BYTES) return invalid;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return invalid;
  }
  const version = (raw as Record<string, unknown> | null)?.['schemaVersion'];
  if (typeof version === 'number' && Number.isInteger(version) && version > SNAPSHOT_METADATA_SCHEMA_VERSION) {
    return { status: 'unreadable', reason: 'newer-schema' };
  }
  // One spelling only: no duplicate keys, reordering or extra whitespace.
  let canonical: string;
  try {
    canonical = canonicalJson(raw);
  } catch {
    return invalid;
  }
  if (canonical !== json) return invalid;
  const parsed = SnapshotMetadata.safeParse(raw);
  return parsed.success ? { status: 'snapshot', metadata: parsed.data } : invalid;
}

// ---- Commit identity (M1 plan §6.1)
//
// The signed-in GitHub user's display name with their noreply address, or the
// fixed Draft Tide identity before sign-in. Never a private email or the
// global Git identity. Git would silently strip `<`, `>`, line breaks and
// leading or trailing punctuation, so names that need it are refused instead:
// what is recorded is exactly what was given.
const IDENT_CRUD = '.,:;"\'\\';

function isIdentName(v: string): boolean {
  if (!isSingleLine(v) || /[<>]/.test(v) || v.trim() !== v) return false;
  return !IDENT_CRUD.includes(v[0] as string) && !IDENT_CRUD.includes(v.at(-1) as string);
}

export const CommitIdentity = z.strictObject({
  name: z.string().min(1).max(200).refine(isIdentName, 'must be a plain single-line name'),
  // Printable ASCII without spaces, `<`, `>` or a second `@`.
  email: z
    .string()
    .min(3)
    .max(254)
    .regex(/^[!-;=?A-~]+@[!-;=?A-~]+$/, 'must be a plain address'),
});
export type CommitIdentity = z.infer<typeof CommitIdentity>;

export const DRAFT_TIDE_IDENTITY: CommitIdentity = { name: 'Draft Tide', email: 'draft-tide@localhost' };

// ---- Save progress: the capture stages, then writing objects and publishing.
export const SAVE_STAGES = [...CAPTURE_STAGES, 'write', 'publish'] as const;
export const SaveStage = z.enum(SAVE_STAGES);
export type SaveStage = z.infer<typeof SaveStage>;

export const SaveProgress = CaptureProgress.extend({ stage: SaveStage });
export type SaveProgress = z.infer<typeof SaveProgress>;
