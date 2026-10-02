import type { CommitRef, HistoryEntry } from '@draft-tide/contracts';
import { KIND_LABEL } from './copy.ts';

// Display formatting. Machine timestamps stay UTC ISO strings everywhere else.
const dateTime = new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' });
const full = new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'full', timeStyle: 'medium' });

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatFull(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : full.format(d);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// "V3" for a Draft Tide version; nothing for other tools' commits.
export function versionLabel(e: Pick<HistoryEntry, 'seq'>): string | null {
  return e.seq === null ? null : `V${e.seq}`;
}

export function entryTitle(e: HistoryEntry): string {
  if (e.source === 'draft-tide' && e.snapshot) return e.snapshot.name ?? `未命名版本（${KIND_LABEL[e.snapshot.kind]}）`;
  return e.title || '（沒有說明）';
}

export function entryTime(e: HistoryEntry): string | null {
  return e.snapshot?.createdAt ?? e.committedAt;
}

// A version an operation names by commit: "V3" when the loaded history shows
// it, else a short id (it may be older than the pages read so far).
export function refLabel(entries: readonly HistoryEntry[], ref: CommitRef): string {
  const e = entries.find((x) => x.commit === ref.commit);
  if (e) return versionLabel(e) ?? '外部變更';
  return `版本 ${shortId(ref.snapshotId ?? ref.commit)}`;
}
