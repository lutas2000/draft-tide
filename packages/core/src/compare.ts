import { diffArrays } from 'diff';
import type {
  ChangeSummary,
  DiffHunk,
  DiffSummaryReason,
  FileChange,
  FileDiff,
  LineEndings,
  TreeFile,
} from '@draft-tide/contracts';
import { compareGitPaths } from './paths.ts';
import { jsonBytes } from './text.ts';

// Comparing two versions (M1 plan §7.2). Which files changed is decided by
// Git's tree and blob ids alone; the line-by-line view of a text file is a
// presentation with its own budgets, never an input to saving or restoring.

// A file of a tree, keyed by path.
export interface TreeFileAt extends TreeFile {
  path: string;
}

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// Added, modified, deleted and renamed files, in path order. A rename is the
// same content and mode under a new path, paired one to one in path order;
// empty files are never paired (any two would match).
export function diffTreeFiles(
  before: readonly TreeFileAt[],
  after: readonly TreeFileAt[],
): { changes: FileChange[]; summary: ChangeSummary } {
  const left = new Map(before.map((f) => [f.path, f]));
  const right = new Map(after.map((f) => [f.path, f]));
  const strip = ({ mode, oid, size }: TreeFileAt): TreeFile => ({ mode, oid, size });
  const changes: FileChange[] = [];
  const deleted: TreeFileAt[] = [];
  const added: TreeFileAt[] = [];
  for (const [path, b] of left) {
    const a = right.get(path);
    if (!a) deleted.push(b);
    else if (a.oid !== b.oid || a.mode !== b.mode) {
      changes.push({ path, change: 'modified', previousPath: null, before: strip(b), after: strip(a) });
    }
  }
  for (const [path, a] of right) if (!left.has(path)) added.push(a);

  const key = (f: TreeFileAt) => `${f.mode}:${f.oid}`;
  const gone = new Map<string, TreeFileAt[]>();
  for (const d of deleted.sort((x, y) => compareGitPaths(x.path, y.path))) {
    if (d.oid === EMPTY_BLOB) continue;
    const list = gone.get(key(d));
    if (list) list.push(d);
    else gone.set(key(d), [d]);
  }
  const moved = new Set<string>();
  let renamed = 0;
  for (const a of added.sort((x, y) => compareGitPaths(x.path, y.path))) {
    const from = a.oid === EMPTY_BLOB ? undefined : gone.get(key(a))?.shift();
    if (from) {
      moved.add(from.path);
      renamed++;
      changes.push({ path: a.path, change: 'renamed', previousPath: from.path, before: strip(from), after: strip(a) });
    } else {
      changes.push({ path: a.path, change: 'added', previousPath: null, before: null, after: strip(a) });
    }
  }
  for (const d of deleted) {
    if (!moved.has(d.path))
      changes.push({ path: d.path, change: 'deleted', previousPath: null, before: strip(d), after: null });
  }
  changes.sort((x, y) => compareGitPaths(x.path, y.path));
  const count = (kind: FileChange['change']) => changes.filter((c) => c.change === kind).length;
  return {
    changes,
    summary: {
      total: changes.length,
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      renamed,
    },
  };
}

// The longest prefix of items whose JSON fits in maxBytes: a list that must
// cross the process boundary in one control message.
export function takeWithinBudget<T>(items: readonly T[], maxBytes: number): { taken: T[]; truncated: boolean } {
  let used = 2;
  const taken: T[] = [];
  for (const item of items) {
    used += jsonBytes(item) + 1;
    if (used > maxBytes) return { taken, truncated: true };
    taken.push(item);
  }
  return { taken, truncated: false };
}

// ---- Text diff

// Budgets for the line-by-line view (TECH_STACK §6.5). They only decide
// whether a file is shown line by line; they never limit what is saved.
export const TEXT_DIFF_BUDGET = {
  // Larger files are shown as a summary.
  maxBytesPerSide: 2 * 1024 * 1024,
  // The diff gives up (too-complex) after this long or this many edits.
  timeoutMs: 3000,
  maxEditLength: 100_000,
  context: 3,
  // Hunks beyond this much JSON are cut (truncated): one control message.
  maxOutputBytes: 640 * 1024,
} as const;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Text Draft Tide can show safely: valid UTF-8 without NUL bytes (Git's own
// binary heuristic looks for NUL in the first 8000 bytes; any NUL counts here).
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

// Lines with their line breaks kept, so a CRLF→LF change is a change.
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

export function lineEndingsOf(lines: readonly string[]): LineEndings {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.endsWith('\r\n')) crlf++;
    else if (l.endsWith('\n')) lf++;
  }
  if (lf === 0 && crlf === 0) return 'none';
  if (lf > 0 && crlf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function diffLineArrays(
  a: string[],
  b: string[],
): Promise<{ value: string[]; added: boolean; removed: boolean }[] | undefined> {
  return new Promise((resolve) => {
    diffArrays(a, b, {
      timeout: TEXT_DIFF_BUDGET.timeoutMs,
      maxEditLength: TEXT_DIFF_BUDGET.maxEditLength,
      callback: (result) => resolve(result),
    });
  });
}

interface Flat {
  op: ' ' | '+' | '-';
  text: string;
}

// Unified-diff hunks with `context` lines around each change; changes closer
// than twice the context share a hunk.
export function buildHunks(lines: readonly Flat[], context: number): DiffHunk[] {
  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l.op !== ' ') changed.push(i);
  });
  const hunks: DiffHunk[] = [];
  let i = 0;
  // Line numbers before position p, on each side.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let n = 0;
  for (const l of lines) {
    oldBefore.push(o);
    newBefore.push(n);
    if (l.op !== '+') o++;
    if (l.op !== '-') n++;
  }
  while (i < changed.length) {
    const first = changed[i] as number;
    let last = first;
    while (i + 1 < changed.length && (changed[i + 1] as number) - last <= 2 * context) last = changed[++i] as number;
    i++;
    const start = Math.max(0, first - context);
    const end = Math.min(lines.length, last + context + 1);
    const slice = lines.slice(start, end);
    const oldLines = slice.filter((l) => l.op !== '+').length;
    const newLines = slice.filter((l) => l.op !== '-').length;
    const oldStartBase = oldBefore[start] ?? 0;
    const newStartBase = newBefore[start] ?? 0;
    hunks.push({
      // Unified diff numbers a range from 1; an empty range names the line
      // before it.
      oldStart: oldLines === 0 ? oldStartBase : oldStartBase + 1,
      oldLines,
      newStart: newLines === 0 ? newStartBase : newStartBase + 1,
      newLines,
      lines: slice.map((l) => `${l.op}${l.text.endsWith('\n') ? l.text.slice(0, -1) : l.text}`),
    });
  }
  return hunks;
}

// The hunks that fit in maxBytes of JSON. The hunk that doesn't fit is cut
// after its last whole line that does, with its line counts to match.
export function fitHunks(hunks: readonly DiffHunk[], maxBytes: number): { taken: DiffHunk[]; truncated: boolean } {
  let used = 2;
  const taken: DiffHunk[] = [];
  for (const h of hunks) {
    const size = jsonBytes(h) + 1;
    if (used + size <= maxBytes) {
      used += size;
      taken.push(h);
      continue;
    }
    const head = jsonBytes({ ...h, lines: [] }) + 1;
    const lines: string[] = [];
    let room = maxBytes - used - head;
    for (const l of h.lines) {
      room -= jsonBytes(l) + 1;
      if (room < 0) break;
      lines.push(l);
    }
    if (lines.length > 0) {
      taken.push({
        ...h,
        oldLines: lines.filter((l) => !l.startsWith('+')).length,
        newLines: lines.filter((l) => !l.startsWith('-')).length,
        lines,
      });
    }
    return { taken, truncated: true };
  }
  return { taken, truncated: false };
}

export interface DiffSide {
  file: TreeFile;
  // The blob's bytes, or null when it is larger than the budget (not read).
  bytes: Uint8Array | null;
}

export async function diffFileContent(
  path: string,
  before: DiffSide | null,
  after: DiffSide | null,
): Promise<FileDiff> {
  const summary = (reason: DiffSummaryReason): FileDiff => ({
    kind: 'summary',
    path,
    before: before?.file ?? null,
    after: after?.file ?? null,
    reason,
  });
  const isBlob = (s: DiffSide | null) => s === null || s.file.mode === '100644' || s.file.mode === '100755';
  if (!isBlob(before) || !isBlob(after)) return summary('not-a-file');
  if (before && after && before.file.oid === after.file.oid) return summary('identical');
  if ((before && before.bytes === null) || (after && after.bytes === null)) return summary('too-large');
  const oldText = before ? decodeText(before.bytes as Uint8Array) : '';
  const newText = after ? decodeText(after.bytes as Uint8Array) : '';
  if (oldText === null || newText === null) return summary('binary');

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const changes = await diffLineArrays(oldLines, newLines);
  if (!changes) return summary('too-complex');
  const flat: Flat[] = [];
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const op = c.added ? '+' : c.removed ? '-' : ' ';
    if (op === '+') added += c.value.length;
    if (op === '-') removed += c.value.length;
    for (const text of c.value) flat.push({ op, text });
  }
  const hunks = buildHunks(flat, TEXT_DIFF_BUDGET.context);
  const { taken, truncated } = fitHunks(hunks, TEXT_DIFF_BUDGET.maxOutputBytes);
  const endsWithoutBreak = (lines: string[]) => lines.length > 0 && !(lines.at(-1) as string).endsWith('\n');
  return {
    kind: 'text',
    path,
    before: before?.file ?? null,
    after: after?.file ?? null,
    added,
    removed,
    hunks: taken,
    truncated,
    lineEndings: {
      before: before ? lineEndingsOf(oldLines) : null,
      after: after ? lineEndingsOf(newLines) : null,
    },
    missingFinalNewline: { before: endsWithoutBreak(oldLines), after: endsWithoutBreak(newLines) },
  };
}
