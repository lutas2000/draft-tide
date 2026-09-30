import { useState } from 'react';
import { cn } from '../lib/cn';
import { formatByteDelta, formatBytes } from '../lib/format';
import { shortHash } from '../lib/hash';
import type { ChangeStatus, FileChange } from '../mock/types';
import { ChevronDown, File, ImageIcon } from './Icons';
import { Badge, type BadgeTone } from './ui/Badge';
import { TextDiff } from './TextDiff';

const statusMeta: Record<ChangeStatus, { label: string; tone: BadgeTone }> = {
  modified: { label: '修改', tone: 'warn' },
  added: { label: '新增', tone: 'ok' },
  deleted: { label: '刪除', tone: 'danger' },
};

export function ChangeBadge({ status }: { status: ChangeStatus }) {
  const m = statusMeta[status];
  return (
    <Badge tone={m.tone} className="w-11 justify-center">
      {m.label}
    </Badge>
  );
}

export function summarizeChanges(changes: FileChange[]): string {
  const c = { modified: 0, added: 0, deleted: 0 };
  for (const ch of changes) c[ch.status]++;
  const parts = [];
  if (c.modified) parts.push(`修改 ${c.modified}`);
  if (c.added) parts.push(`新增 ${c.added}`);
  if (c.deleted) parts.push(`刪除 ${c.deleted}`);
  return parts.join(' · ');
}

function sizeText(ch: FileChange): string {
  if (ch.status === 'added') return formatBytes(ch.after?.size ?? 0);
  if (ch.status === 'deleted') return formatBytes(ch.before?.size ?? 0);
  const a = ch.before?.size ?? 0;
  const b = ch.after?.size ?? 0;
  return `${formatBytes(a)} → ${formatBytes(b)}（${formatByteDelta(b - a)}）`;
}

/** File change rows. Text files expand into a read-only diff; binaries into size + short hash. */
export function FileChangeList({ changes, defaultOpen }: { changes: FileChange[]; defaultOpen?: string }) {
  const [open, setOpen] = useState<string | null>(defaultOpen ?? null);
  if (changes.length === 0) return <p className="py-3 text-sm text-ink-3">兩個版本的檔案完全相同。</p>;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {changes.map((ch) => {
        const isOpen = open === ch.path;
        const kind = (ch.after ?? ch.before)?.kind ?? 'text';
        const Icon = kind === 'binary' ? ImageIcon : File;
        return (
          <li key={ch.path}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : ch.path)}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-raised"
            >
              <ChangeBadge status={ch.status} />
              <Icon className="size-4 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{ch.path}</span>
              <span className="text-[12px] text-ink-3">{sizeText(ch)}</span>
              <ChevronDown className={cn('size-4 text-ink-3 transition-transform', !isOpen && '-rotate-90')} />
            </button>
            {isOpen && (
              <div className="border-t border-line bg-canvas/50 px-3.5 py-3">
                {kind === 'text' ? (
                  <TextDiff before={ch.before?.text ?? ''} after={ch.after?.text ?? ''} />
                ) : (
                  <BinaryDetails change={ch} />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BinaryDetails({ change }: { change: FileChange }) {
  return (
    <div className="grid gap-2 text-[12px] text-ink-2">
      <p>二進位檔案不顯示文字差異；以大小與內容雜湊辨識是否相同。</p>
      <div className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-1">
        {change.before && (
          <>
            <span className="text-ink-3">之前</span>
            <span>
              {formatBytes(change.before.size)} · <code className="font-mono">{shortHash(change.before.hash)}</code>
            </span>
          </>
        )}
        {change.after && (
          <>
            <span className="text-ink-3">之後</span>
            <span>
              {formatBytes(change.after.size)} · <code className="font-mono">{shortHash(change.after.hash)}</code>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
