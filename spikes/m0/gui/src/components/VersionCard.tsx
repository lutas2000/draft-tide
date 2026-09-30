import { cn } from '../lib/cn';
import { formatFull, formatWhen } from '../lib/format';
import type { Version } from '../mock/types';
import { DesignFrame } from './DesignFrame';
import { SourceBadge } from './SourceBadge';

export function versionTitle(v: Version): string {
  return v.meta.name ?? '未命名版本';
}

export function VersionCard({
  version,
  entry,
  selected,
  isCurrent,
  highlight,
  onSelect,
}: {
  version: Version;
  entry: string;
  selected: boolean;
  isCurrent: boolean;
  highlight?: boolean;
  onSelect: () => void;
}) {
  const title = versionTitle(version);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${version.label}「${title}」，${formatWhen(version.meta.createdAt)}`}
      className={cn(
        'group flex flex-col rounded-lg border bg-surface p-2 text-left shadow-card transition',
        selected ? 'border-tide-500 ring-2 ring-tide-200' : 'border-line hover:border-line-strong hover:shadow-raised',
        highlight && !selected && 'ring-2 ring-restore-soft',
      )}
    >
      <div className="relative">
        <DesignFrame files={version.files} entry={entry} title={`${version.label} 預覽`} status={version.previewStatus} />
        <span className="absolute top-2 left-2 rounded-sm bg-ink/75 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white backdrop-blur-sm">
          {version.label}
        </span>
        {isCurrent && (
          <span className="absolute top-2 right-2 rounded-sm bg-surface/95 px-1.5 py-0.5 text-[11px] font-medium text-tide-700 shadow-card">
            資料夾目前是這版
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-1.5 pt-2.5 pb-1">
        <div className={cn('truncate text-[14px] font-semibold', !version.meta.name && 'text-ink-3')}>{title}</div>
        <div className="flex items-center justify-between gap-2">
          <time dateTime={version.meta.createdAt} title={formatFull(version.meta.createdAt)} className="text-[12px] text-ink-3">
            {formatWhen(version.meta.createdAt)}
          </time>
          <SourceBadge kind={version.meta.kind} />
        </div>
      </div>
    </button>
  );
}
