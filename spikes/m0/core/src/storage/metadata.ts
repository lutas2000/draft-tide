import { z } from 'zod';

export const SNAPSHOT_KINDS = ['baseline', 'manual', 'agent-requested', 'pre-restore', 'restore'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];
export type Origin = 'gui' | 'cli' | 'mcp' | 'harness';

// M1 plan §5.2 required fields plus the optional ones. No absolute paths,
// prompts, keys or approval data may ever be added here.
export const SnapshotMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.uuid(),
    kind: z.enum(SNAPSHOT_KINDS),
    createdAt: z.iso.datetime(),
    scopeHash: z.string().regex(/^[0-9a-f]{64}$/),
    provider: z.literal('filesystem'),
    entryFiles: z.array(z.string().max(1024)).max(16),
    origin: z.enum(['gui', 'cli', 'mcp', 'harness']),
    name: z.string().max(200).optional(),
    operationId: z.uuid().optional(),
    restoreOf: z.uuid().optional(),
  })
  .strict();

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;

const MARKER = 'Draft-Tide-Metadata-v1: ';
const MAX_METADATA_BYTES = 16 * 1024;

// Sorted keys, no whitespace, JSON-only values: the same object always
// serializes to the same bytes.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`unsupported type in canonical JSON: ${typeof value}`);
}

const KIND_TITLES: Record<SnapshotKind, string> = {
  baseline: 'Baseline',
  manual: 'Saved version',
  'agent-requested': 'Saved version (requested by agent)',
  'pre-restore': 'Protection before restore',
  restore: 'Restored version',
};

export function sanitizeName(name: string): string {
  // Control characters and line breaks never reach the commit message.
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}

export function formatCommitMessage(meta: SnapshotMetadata): string {
  SnapshotMetadataSchema.parse(meta);
  const json = canonicalJson(meta);
  if (Buffer.byteLength(json) > MAX_METADATA_BYTES) throw new Error('snapshot metadata exceeds budget');
  const title = meta.name ? sanitizeName(meta.name) : KIND_TITLES[meta.kind];
  return `${title}\n\n${MARKER}${json}\n`;
}

export function parseCommitMessage(message: string): SnapshotMetadata | null {
  const line = message.split('\n').reverse().find((l) => l.startsWith(MARKER));
  if (!line) return null;
  const raw = line.slice(MARKER.length);
  if (Buffer.byteLength(raw) > MAX_METADATA_BYTES) return null;
  const parsed = SnapshotMetadataSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
