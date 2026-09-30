import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { textDiff } from '../lib/diff';

/**
 * Read-only text diff. Every line is rendered as a React text node, so file
 * content is always escaped (never injected as HTML).
 */
export function TextDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => textDiff(before, after), [before, after]);
  if (diff.hunks.length === 0) return <p className="text-[12px] text-ink-3">文字內容相同。</p>;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-line bg-raised px-3 py-1.5 text-[12px] text-ink-3">
        <span className="text-diff-add-ink">+{diff.added} 行</span>
        <span className="text-diff-del-ink">−{diff.removed} 行</span>
        <span className="ml-auto">唯讀</span>
      </div>
      <div className="dt-scroll max-h-[420px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.65]">
          <tbody>
            {diff.hunks.map((h, hi) => (
              <HunkRows key={hi} hunk={h} />
            ))}
            {diff.skippedAfter > 0 && <SkipRow count={diff.skippedAfter} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SkipRow({ count }: { count: number }) {
  return (
    <tr>
      <td colSpan={4} className="bg-sunken/60 px-3 py-0.5 text-[11px] text-ink-3 select-none">
        ⋯ {count} 行未變更
      </td>
    </tr>
  );
}

function HunkRows({ hunk }: { hunk: ReturnType<typeof textDiff>['hunks'][number] }) {
  return (
    <>
      {hunk.skippedBefore > 0 && <SkipRow count={hunk.skippedBefore} />}
      {hunk.lines.map((l, i) => (
        <tr
          key={i}
          className={cn(
            l.type === 'add' && 'bg-diff-add',
            l.type === 'del' && 'bg-diff-del',
          )}
        >
          <td className="w-10 border-r border-line/70 px-2 text-right align-top text-ink-3 select-none">{l.oldNo ?? ''}</td>
          <td className="w-10 border-r border-line/70 px-2 text-right align-top text-ink-3 select-none">{l.newNo ?? ''}</td>
          <td
            className={cn(
              'w-5 text-center align-top select-none',
              l.type === 'add' && 'text-diff-add-ink',
              l.type === 'del' && 'text-diff-del-ink',
            )}
            aria-label={l.type === 'add' ? '新增' : l.type === 'del' ? '刪除' : undefined}
          >
            {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}
          </td>
          <td className={cn('pr-4 whitespace-pre text-ink', l.type === 'add' && 'text-diff-add-ink', l.type === 'del' && 'text-diff-del-ink')}>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}
