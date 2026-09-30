/**
 * Minimal read-only line diff (LCS) for the prototype's text details.
 * Example files are small, so an O(n·m) table is fine. The real product plans
 * to use jsdiff inside the Engine; the GUI would only render its result.
 */
export type DiffLine =
  | { type: 'ctx'; text: string; oldNo: number; newNo: number }
  | { type: 'add'; text: string; oldNo: null; newNo: number }
  | { type: 'del'; text: string; oldNo: number; newNo: null };

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  /** Unchanged lines skipped before this hunk. */
  skippedBefore: number;
}

export interface TextDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  skippedAfter: number;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] ?? '', oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
      out.push({ type: 'add', text: b[j] ?? '', oldNo: null, newNo: j + 1 });
      j++;
    } else {
      out.push({ type: 'del', text: a[i] ?? '', oldNo: i + 1, newNo: null });
      i++;
    }
  }
  return out;
}

export function textDiff(before: string, after: string, context = 3): TextDiff {
  const lines = lineDiff(before, after);
  const changed = lines.map((l) => l.type !== 'ctx');
  const keep = lines.map((_, idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      if (changed[k]) return true;
    }
    return false;
  });
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let skipped = 0;
  lines.forEach((line, idx) => {
    if (!keep[idx]) {
      if (current) {
        hunks.push(current);
        current = null;
      }
      skipped++;
      return;
    }
    if (!current) {
      current = {
        oldStart: line.oldNo ?? (line.newNo ?? 1),
        newStart: line.newNo ?? (line.oldNo ?? 1),
        lines: [],
        skippedBefore: skipped,
      };
      skipped = 0;
    }
    current.lines.push(line);
  });
  if (current) hunks.push(current);
  return {
    hunks,
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
    skippedAfter: skipped,
  };
}
