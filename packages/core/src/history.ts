import {
  DtError,
  GIT_OID_PATTERN,
  IsoTimestamp,
  readCommitMetadata,
  type HistoryEntry as HistoryEntryDto,
  type HistorySource,
  type SnapshotId,
  type SnapshotMetadata,
  type VersionInfo,
} from '@draft-tide/contracts';
import type { GitCommit, GitHistory, GitOid } from './ports.ts';
import { printable } from './text.ts';

// History is read from Git alone: the branch's first-parent line and each
// commit's metadata. Nothing else decides which versions exist, so any index
// or cache built from this can be dropped and rebuilt (M1 plan §6.1).

export interface HistoryEntry {
  commit: GitOid;
  tree: GitOid;
  parents: GitOid[];
  // First line of the message, cut to 200 characters.
  title: string;
  // Draft Tide's metadata; null for a commit another tool made (an external
  // change) or one whose metadata can't be read (see unreadable).
  snapshot: SnapshotMetadata | null;
  unreadable: 'invalid' | 'newer-schema' | null;
  author: { name: string; email: string };
  // null when the commit's time can't be represented.
  committedAt: IsoTimestamp | null;
}

const TITLE_LENGTH = 200;

function isoFromSeconds(seconds: number): IsoTimestamp | null {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const iso = IsoTimestamp.safeParse(date.toISOString());
  return iso.success ? iso.data : null;
}

export function historyEntry(commit: GitCommit): HistoryEntry {
  const meta = readCommitMetadata(commit.message);
  return {
    commit: commit.oid,
    tree: commit.tree,
    parents: commit.parents,
    title: (commit.message.split('\n', 1)[0] ?? '').slice(0, TITLE_LENGTH),
    snapshot: meta.status === 'snapshot' ? meta.metadata : null,
    unreadable: meta.status === 'unreadable' ? meta.reason : null,
    author: { name: commit.author.name, email: commit.author.email },
    committedAt: isoFromSeconds(commit.committer.time),
  };
}

// One page of the branch's first-parent line, newest first.
export async function readHistory(
  git: Pick<GitHistory, 'firstParentLine' | 'readCommits'>,
  tip: GitOid | null,
  page: { skip: number; limit: number },
  signal?: AbortSignal,
): Promise<HistoryEntry[]> {
  if (tip === null) return [];
  const oids = await git.firstParentLine(tip, page, signal);
  return (await git.readCommits(oids, signal)).map(historyEntry);
}

// ---- The branch's line, indexed (M1-04)
//
// Snapshot ids are resolved, and versions numbered, along the first-parent
// line of the checked-out branch. A Draft Tide commit another tool copied
// (cherry-pick, a rebase of someone's branch) repeats an older snapshot id:
// the oldest commit carrying an id is the version, later ones are copies and
// show as other tools' changes. Built from Git alone, so it can be dropped and
// rebuilt at any time.

export interface LineIndex {
  tip: GitOid;
  // Newest first.
  commits: GitOid[];
  position: Map<GitOid, number>;
  // Every commit carrying readable Draft Tide metadata, copies included.
  snapshotOf: Map<GitOid, SnapshotId>;
  // The version itself: the oldest commit carrying each id.
  originalOf: Map<SnapshotId, GitOid>;
  // Display numbers (V1, V2…) of the versions, counted from the oldest.
  seqOf: Map<GitOid, number>;
}

const LINE_PAGE = 10_000;
// Commit objects are read in batches; each is kept up to 1 MiB.
const READ_BATCH = 200;

export async function buildLineIndex(
  git: Pick<GitHistory, 'firstParentLine' | 'readCommits'>,
  tip: GitOid,
  signal?: AbortSignal,
): Promise<LineIndex> {
  const commits: GitOid[] = [];
  for (let skip = 0; ; skip += LINE_PAGE) {
    const page = await git.firstParentLine(tip, { skip, limit: LINE_PAGE }, signal);
    commits.push(...page);
    if (page.length < LINE_PAGE) break;
  }
  const snapshotOf = new Map<GitOid, SnapshotId>();
  for (let i = 0; i < commits.length; i += READ_BATCH) {
    for (const c of await git.readCommits(commits.slice(i, i + READ_BATCH), signal)) {
      const meta = readCommitMetadata(c.message);
      if (meta.status === 'snapshot') snapshotOf.set(c.oid, meta.metadata.snapshotId);
    }
  }
  const originalOf = new Map<SnapshotId, GitOid>();
  const seqOf = new Map<GitOid, number>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const oid = commits[i] as GitOid;
    const id = snapshotOf.get(oid);
    if (id === undefined || originalOf.has(id)) continue;
    originalOf.set(id, oid);
    seqOf.set(oid, seqOf.size + 1);
  }
  return { tip, commits, position: new Map(commits.map((c, i) => [c, i])), snapshotOf, originalOf, seqOf };
}

// A snapshot id, or the id of a commit on the line. Nothing else: no
// revision expressions, no commits from other branches.
export function resolveVersionRef(index: LineIndex, ref: string): GitOid {
  if (GIT_OID_PATTERN.test(ref)) {
    if (index.position.has(ref)) return ref;
  } else {
    const commit = index.originalOf.get(ref as SnapshotId);
    if (commit !== undefined) return commit;
  }
  throw new DtError('SNAPSHOT_NOT_FOUND', "no version with this id is in the project's history", { ref });
}

// The history entry as it crosses the process boundary.
export function historyEntryOf(commit: GitCommit, index: LineIndex): HistoryEntryDto {
  const entry = historyEntry(commit);
  const id = entry.snapshot?.snapshotId;
  const original = id === undefined ? undefined : index.originalOf.get(id);
  const isCopy = original !== undefined && original !== commit.oid;
  let source: HistorySource = 'external';
  if (entry.unreadable) source = 'unreadable';
  else if (entry.snapshot) source = isCopy ? 'copy' : 'draft-tide';
  const meta = source === 'draft-tide' ? entry.snapshot : null;
  return {
    commit: commit.oid,
    parents: commit.parents.slice(0, 64),
    title: printable(entry.title, 200),
    source,
    snapshot: meta
      ? {
          snapshotId: meta.snapshotId,
          kind: meta.kind,
          name: meta.name ?? null,
          createdAt: meta.createdAt,
          origin: meta.origin,
          restoreOf: meta.restoreOf ?? null,
        }
      : null,
    unreadable: entry.unreadable,
    copyOf: isCopy ? (original ?? null) : null,
    seq: index.seqOf.get(commit.oid) ?? null,
    authorName: printable(entry.author.name, 200),
    committedAt: entry.committedAt,
  };
}

export function versionInfoOf(commit: GitCommit, index: LineIndex): VersionInfo {
  const entry = historyEntryOf(commit, index);
  return { commit: commit.oid, snapshotId: entry.snapshot?.snapshotId ?? null, seq: entry.seq, title: entry.title };
}
