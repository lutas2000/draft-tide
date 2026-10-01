import { IsoTimestamp, readCommitMetadata, type SnapshotMetadata } from '@draft-tide/contracts';
import type { GitCommit, GitHistory, GitOid } from './ports.ts';

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
