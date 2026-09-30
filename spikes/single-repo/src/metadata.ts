// Commit-message metadata. Much smaller than the M0 version: scope policy and
// entry files now live in .drafttide.json inside the tree, so each commit
// carries its own configuration and the message only identifies the snapshot.
// Never add absolute paths, prompts, keys or approval data here.
export const SNAPSHOT_KINDS = ['baseline', 'manual', 'pre-restore', 'restore'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];
export type Origin = 'gui' | 'cli' | 'mcp' | 'harness';

export interface SnapshotMetadata {
  schemaVersion: 1;
  snapshotId: string;
  kind: SnapshotKind;
  createdAt: string;
  origin: Origin;
  name?: string;
  operationId?: string;
  restoreOf?: string;
}

const MARKER = 'Draft-Tide-Metadata-v1: ';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`unsupported type in canonical JSON: ${typeof value}`);
}

const TITLES: Record<SnapshotKind, string> = {
  baseline: 'Baseline',
  manual: 'Saved version',
  'pre-restore': 'Protection before restore',
  restore: 'Restored version',
};

export function formatCommitMessage(meta: SnapshotMetadata): string {
  const title = meta.name ? meta.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : TITLES[meta.kind];
  return `${title}\n\n${MARKER}${canonicalJson(meta)}\n`;
}

// Commits made by other tools (an engineer, an agent running `git commit`)
// have no marker: they are still history, just not Draft Tide snapshots.
export function parseCommitMessage(message: string): SnapshotMetadata | null {
  const line = message.split('\n').reverse().find((l) => l.startsWith(MARKER));
  if (!line) return null;
  try {
    const raw = JSON.parse(line.slice(MARKER.length)) as Record<string, unknown>;
    if (raw['schemaVersion'] !== 1 || typeof raw['snapshotId'] !== 'string' || !UUID_RE.test(raw['snapshotId'])) return null;
    if (!SNAPSHOT_KINDS.includes(raw['kind'] as SnapshotKind)) return null;
    if (typeof raw['createdAt'] !== 'string' || !['gui', 'cli', 'mcp', 'harness'].includes(raw['origin'] as string)) return null;
    return raw as unknown as SnapshotMetadata;
  } catch {
    return null;
  }
}
