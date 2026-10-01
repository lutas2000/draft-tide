import fc from 'fast-check';
import type { DiffHunk, FileDiff, TreeFile } from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import {
  TEXT_DIFF_BUDGET,
  decodeText,
  diffFileContent,
  diffTreeFiles,
  lineEndingsOf,
  splitLines,
  takeWithinBudget,
  type DiffSide,
  type TreeFileAt,
} from '../src/index.ts';
import { oidOf } from './world.ts';

const at = (path: string, content: string, mode = '100644'): TreeFileAt => ({
  path,
  mode,
  oid: oidOf(Buffer.from(content)),
  size: Buffer.byteLength(content),
});

const side = (content: string | Buffer | null, mode = '100644'): DiffSide | null => {
  if (content === null) return null;
  const bytes = Buffer.from(content);
  const file: TreeFile = { mode, oid: oidOf(bytes), size: bytes.length };
  return { file, bytes };
};

// Applies unified-diff hunks to the old lines: what a patch tool would do.
function applyHunks(oldText: string, hunks: readonly DiffHunk[]): string[] {
  const old = splitLines(oldText).map((l) => l.replace(/\n$/, ''));
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    out.push(...old.slice(pos, start));
    pos = start;
    for (const line of h.lines) {
      const op = line[0];
      const text = line.slice(1);
      if (op === ' ') {
        expect(old[pos]).toBe(text);
        out.push(text);
        pos++;
      } else if (op === '-') {
        expect(old[pos]).toBe(text);
        pos++;
      } else out.push(text);
    }
  }
  out.push(...old.slice(pos));
  return out;
}

const text = (d: FileDiff) => {
  if (d.kind !== 'text') throw new Error(`expected a text diff, got ${d.reason}`);
  return d;
};

describe('diffTreeFiles', () => {
  it('reports added, modified, deleted and mode-only changes in Git path order', () => {
    const { changes, summary } = diffTreeFiles(
      [at('b.css', 'b'), at('a.html', 'a'), at('gone.js', 'g'), at('run.sh', 'x')],
      [at('a.html', 'a2'), at('b.css', 'b'), at('new.png', 'n'), at('run.sh', 'x', '100755')],
    );
    expect(changes.map((c) => [c.change, c.path])).toEqual([
      ['modified', 'a.html'],
      ['deleted', 'gone.js'],
      ['added', 'new.png'],
      ['modified', 'run.sh'],
    ]);
    expect(summary).toEqual({ total: 4, added: 1, modified: 2, deleted: 1, renamed: 0 });
  });

  it('pairs a move of identical content as a rename, one to one', () => {
    const { changes, summary } = diffTreeFiles(
      [at('img/a.png', 'same'), at('img/b.png', 'same'), at('old.txt', 'x')],
      [at('assets/a.png', 'same'), at('new.txt', 'y')],
    );
    expect(changes.map((c) => [c.change, c.previousPath, c.path])).toEqual([
      ['renamed', 'img/a.png', 'assets/a.png'],
      ['deleted', null, 'img/b.png'],
      ['added', null, 'new.txt'],
      ['deleted', null, 'old.txt'],
    ]);
    expect(summary.renamed).toBe(1);
  });

  it('never pairs empty files, nor content whose mode changed', () => {
    const { changes } = diffTreeFiles([at('a', ''), at('x.sh', 'echo')], [at('b', ''), at('y.sh', 'echo', '100755')]);
    expect(changes.map((c) => c.change).sort()).toEqual(['added', 'added', 'deleted', 'deleted']);
  });

  it('agrees with itself both ways round', () => {
    const tree = fc.uniqueArray(
      fc.record({ path: fc.constantFrom('a', 'b', 'c/d', 'e', 'f/g'), content: fc.constantFrom('1', '2', '3') }),
      { selector: (r) => r.path },
    );
    fc.assert(
      fc.property(tree, tree, (x, y) => {
        const left = x.map((f) => at(f.path, f.content));
        const right = y.map((f) => at(f.path, f.content));
        const there = diffTreeFiles(left, right).summary;
        const back = diffTreeFiles(right, left).summary;
        expect(back).toEqual({ ...there, added: there.deleted, deleted: there.added });
      }),
    );
  });
});

describe('takeWithinBudget', () => {
  it('keeps the longest prefix whose JSON fits', () => {
    const items = ['aaaa', 'bbbb', 'cccc'];
    expect(takeWithinBudget(items, 1000)).toEqual({ taken: items, truncated: false });
    expect(takeWithinBudget(items, 16)).toEqual({ taken: ['aaaa', 'bbbb'], truncated: true });
    expect(takeWithinBudget(items, 3)).toEqual({ taken: [], truncated: true });
  });
});

describe('text decoding and lines', () => {
  it('treats NUL bytes and invalid UTF-8 as binary', () => {
    expect(decodeText(Buffer.from('héllo 你好 🌊'))).toBe('héllo 你好 🌊');
    expect(decodeText(Buffer.from([0x68, 0x00, 0x69]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  });

  it('keeps line breaks and names the line endings', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitLines('')).toEqual([]);
    expect(lineEndingsOf(splitLines('a\nb\n'))).toBe('lf');
    expect(lineEndingsOf(splitLines('a\r\nb\r\n'))).toBe('crlf');
    expect(lineEndingsOf(splitLines('a\r\nb\n'))).toBe('mixed');
    expect(lineEndingsOf(splitLines('one line'))).toBe('none');
  });
});

describe('diffFileContent', () => {
  it('produces hunks that turn the old text into the new one', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', '', '<div>', '  x'), { maxLength: 40 });
    fc.assert(
      fc.property(lines, lines, fc.boolean(), (a, b, finalBreak) => {
        const oldText = a.length ? `${a.join('\n')}\n` : '';
        const newText = b.length ? `${b.join('\n')}${finalBreak ? '\n' : ''}` : '';
        const d = diffFileContent('f.txt', side(oldText), side(newText));
        if (oldText === newText) {
          expect(d).toMatchObject({ kind: 'summary', reason: 'identical' });
          return;
        }
        const t = text(d);
        expect(t.truncated).toBe(false);
        expect(applyHunks(oldText, t.hunks)).toEqual(splitLines(newText).map((l) => l.replace(/\n$/, '')));
        const plus = t.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('+')).length;
        const minus = t.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('-')).length;
        expect([t.added, t.removed]).toEqual([plus, minus]);
        for (const h of t.hunks) {
          expect(h.lines.filter((l) => !l.startsWith('+')).length).toBe(h.oldLines);
          expect(h.lines.filter((l) => !l.startsWith('-')).length).toBe(h.newLines);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps three lines of context and splits distant changes into hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[2] = 'changed 3';
    after[25] = 'changed 26';
    const t = text(diffFileContent('f', side(`${before.join('\n')}\n`), side(`${after.join('\n')}\n`)));
    expect(t.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 6, 1, 6],
      [23, 7, 23, 7],
    ]);
    expect(t.hunks[0]?.lines).toEqual([' line 1', ' line 2', '-line 3', '+changed 3', ' line 4', ' line 5', ' line 6']);
  });

  it('shows a CRLF to LF change as a change, with the line endings named', () => {
    const t = text(diffFileContent('f', side('a\r\nb\r\n'), side('a\nb\n')));
    expect(t.hunks[0]?.lines).toEqual(['-a\r', '-b\r', '+a', '+b']);
    expect(t.lineEndings).toEqual({ before: 'crlf', after: 'lf' });
  });

  it('notices a final line break that came or went', () => {
    const t = text(diffFileContent('f', side('a\nb'), side('a\nb\n')));
    expect(t.missingFinalNewline).toEqual({ before: true, after: false });
    expect(t.hunks[0]?.lines).toEqual([' a', '-b', '+b']);
  });

  it('diffs an added or a deleted file against nothing', () => {
    const added = text(diffFileContent('f', null, side('x\ny\n')));
    expect(added.hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]);
    expect(added.before).toBeNull();
    const deleted = text(diffFileContent('f', side('x\n'), null));
    expect(deleted.hunks).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-x'] }]);
  });

  it('summarizes what it does not show line by line', () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    expect(diffFileContent('a.png', side(png), side(Buffer.concat([png, Buffer.from([1])])))).toMatchObject({
      kind: 'summary',
      reason: 'binary',
    });
    const big = side('x');
    expect(diffFileContent('big.js', big && { ...big, bytes: null }, side('y'))).toMatchObject({
      reason: 'too-large',
    });
    expect(diffFileContent('link', side('target', '120000'), side('other', '120000'))).toMatchObject({
      reason: 'not-a-file',
    });
    expect(diffFileContent('same', side('x'), side('x'))).toMatchObject({ reason: 'identical' });
  });

  it('shows a 1,000-line rewrite line by line, well within the time budget', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `<p>old ${i}</p>\n`).join('');
    const after = Array.from({ length: 1000 }, (_, i) => `<p>new ${i}</p>\n`).join('');
    const started = performance.now();
    const t = text(diffFileContent('page.html', side(before), side(after)));
    expect(performance.now() - started).toBeLessThan(TEXT_DIFF_BUDGET.timeoutMs);
    expect([t.added, t.removed]).toEqual([1000, 1000]);
  });

  it('cuts the hunks to the output budget and says so', () => {
    const long = 'y'.repeat(2000);
    const lines = Array.from({ length: 600 }, (_, i) => `${i}${long}`);
    const t = text(diffFileContent('f', side(''), side(`${lines.join('\n')}\n`)));
    expect(t.added).toBe(600);
    expect(t.truncated).toBe(true);
    // The one long hunk is cut after its last line that fits.
    const [hunk] = t.hunks;
    expect(hunk?.lines.length).toBeGreaterThan(100);
    expect(hunk?.lines.length).toBeLessThan(600);
    expect(hunk?.newLines).toBe(hunk?.lines.length);
    expect(JSON.stringify(t.hunks).length).toBeLessThanOrEqual(TEXT_DIFF_BUDGET.maxOutputBytes);
  });
});
