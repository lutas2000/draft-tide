import { useId, useState } from 'react';
import {
  previewKindOf,
  type DiffHunk,
  type FileChange,
  type FileDiff,
  type HistoryEntry,
  type ProjectId,
  type TreeFile,
} from '@draft-tide/contracts';
import { Check, ChevronDown, ChevronLeft, FileIcon } from '../components/icons.tsx';
import { PreviewWithDialog } from '../components/preview.tsx';
import { Badge, type BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { cn } from '../lib/cn.ts';
import { useDiff, useFileDiff, useHistory } from '../lib/engine-state.ts';
import { usePreview } from '../lib/preview.ts';
import { entryTime, entryTitle, formatBytes, formatWhen, shortId, versionLabel } from '../lib/format.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';
import { SourceBadge, refOf, summarize } from './project.tsx';

// 版本比較 (M1 plan §4.1, §7.2): the two versions' pictures side by side
// (rendered by the isolated Preview Host, M1-06), then the files that differ,
// with a read-only line view for text and both pictures of a changed PNG or
// JPEG. Every line is a React text node: content is never interpreted as
// HTML.

const CHANGE: Record<FileChange['change'], { label: string; tone: BadgeTone }> = {
  added: { label: '新增', tone: 'ok' },
  modified: { label: '修改', tone: 'warn' },
  deleted: { label: '刪除', tone: 'danger' },
  renamed: { label: '改名', tone: 'tide' },
};

function optionLabel(e: HistoryEntry): string {
  const when = entryTime(e);
  return [versionLabel(e) ?? '外部變更', entryTitle(e), when ? formatWhen(when) : null].filter(Boolean).join(' · ');
}

function VersionPicker({
  label,
  value,
  entries,
  onChange,
}: {
  label: string;
  value: string;
  entries: HistoryEntry[];
  onChange: (ref: string) => void;
}) {
  const id = useId();
  const known = entries.some((e) => refOf(e) === value);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-[12px] text-ink-3">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium focus:border-tide-500"
      >
        {!known && <option value={value}>{shortId(value)}</option>}
        {entries.map((e) => (
          <option key={e.commit} value={refOf(e)}>
            {optionLabel(e)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CompareScreen({
  projectId,
  from,
  to,
  navigate,
}: {
  projectId: ProjectId;
  from: string;
  to: string;
  navigate: Navigate;
}) {
  const history = useHistory(projectId);
  const diff = useDiff(projectId, from, to);
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? [];
  const set = (f: string, t: string) => navigate({ name: 'compare', projectId, from: f, to: t });
  const firstText = diff.data?.changes.find((c) => c.change !== 'deleted' && c.change !== 'renamed')?.path ?? null;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-5 px-page pt-6 pb-24">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'project', projectId })}>
          <ChevronLeft />
          版本歷史
        </Button>
        <h1 className="text-[20px] font-semibold tracking-tight">比較版本</h1>
      </div>

      <Card className="flex items-end gap-3 p-4">
        <VersionPicker label="較早" value={from} entries={entries} onChange={(f) => set(f, to)} />
        <Button variant="ghost" size="sm" aria-label="左右交換" title="左右交換" onClick={() => set(to, from)}>
          ⇄
        </Button>
        <VersionPicker label="較新" value={to} entries={entries} onChange={(t) => set(from, t)} />
      </Card>
      {from !== to && <SideBySide projectId={projectId} from={from} to={to} entries={entries} />}

      {from === to ? (
        <Card className="px-4 py-6 text-center text-sm text-ink-3">請選擇兩個不同的版本。</Card>
      ) : diff.isError ? (
        <ErrorNote error={diff.error} />
      ) : diff.isPending ? (
        <Card className="px-4 py-6 text-center text-sm text-ink-3">比較中…</Card>
      ) : (
        <section aria-labelledby="changes-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 id="changes-title" className="text-[15px] font-semibold">
              檔案變更
            </h2>
            <span className="text-[13px] text-ink-2">
              {diff.data.summary.total === 0 ? '兩個版本的檔案完全相同' : summarize(diff.data.summary)}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <SourceBadgeFor entries={entries} commit={diff.data.from.commit} />
              <span className="text-ink-3">→</span>
              <SourceBadgeFor entries={entries} commit={diff.data.to.commit} />
            </span>
          </div>
          {diff.data.changes.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface" aria-label="檔案變更">
              {diff.data.changes.map((c) => (
                <ChangeRow
                  key={c.path}
                  projectId={projectId}
                  from={from}
                  to={to}
                  change={c}
                  defaultOpen={c.path === firstText}
                />
              ))}
            </ul>
          )}
          {diff.data.truncated && (
            <p className="text-[12px] text-warn">
              變更太多，這裡只列出前 {diff.data.changes.length} 個（共 {diff.data.summary.total} 個）。
            </p>
          )}
          <p className="text-[12px] text-ink-3">
            文字檔可以展開查看逐行差異（唯讀）；PNG 與 JPEG 圖片可以展開並排比較；其他檔案顯示大小與內容識別碼。
          </p>
        </section>
      )}
    </div>
  );
}

function labelFor(entries: HistoryEntry[], ref: string): string {
  const e = entries.find((x) => refOf(x) === ref || x.commit === ref);
  return e ? (versionLabel(e) ?? `「${entryTitle(e)}」`) : shortId(ref);
}

// Both versions' entry pages at the same fixed size. Equal pictures are said
// to be equal (same pixels); everything else is for the eye.
function SideBySide({
  projectId,
  from,
  to,
  entries,
}: {
  projectId: ProjectId;
  from: string;
  to: string;
  entries: HistoryEntry[];
}) {
  const a = usePreview(projectId, from);
  const b = usePreview(projectId, to);
  const same = a.data && b.data && a.data.image.sha256 === b.data.image.sha256;
  return (
    <section aria-labelledby="screens-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 id="screens-title" className="text-[15px] font-semibold">
          畫面
        </h2>
        <span className="text-[13px] text-ink-3">預覽頁面在 1280×800 視窗中的樣子（離線產生）</span>
        {same && (
          <span className="flex items-center gap-1 text-[13px] text-ok" role="status">
            <Check className="size-3.5" />
            兩個版本的畫面完全相同
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[
          { side: '較早', ref: from },
          { side: '較新', ref: to },
        ].map(({ side, ref }) => (
          <div key={side} className="flex min-w-0 flex-col gap-1.5">
            <p className="text-[12px] text-ink-3">
              {side} · <span className="font-medium text-ink-2">{labelFor(entries, ref)}</span>
            </p>
            <PreviewWithDialog projectId={projectId} version={ref} label={labelFor(entries, ref)} />
          </div>
        ))}
      </div>
    </section>
  );
}

// A changed PNG or JPEG, as each version holds it.
function ImagePair({
  projectId,
  from,
  to,
  path,
  previousPath,
  before,
  after,
}: {
  projectId: ProjectId;
  from: string;
  to: string;
  path: string;
  previousPath: string;
  before: boolean;
  after: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {[
        { side: '之前', ref: from, file: previousPath, present: before },
        { side: '之後', ref: to, file: path, present: after },
      ].map(({ side, ref, file, present }) => (
        <div key={side} className="flex min-w-0 flex-col gap-1.5">
          <p className="text-[12px] text-ink-3">{side}</p>
          {present ? (
            <PreviewWithDialog projectId={projectId} version={ref} file={file} label={side} />
          ) : (
            <div className="grid aspect-[16/10] place-items-center rounded-md border border-dashed border-line text-[12px] text-ink-3">
              {side === '之前' ? '這個版本還沒有這張圖片' : '這個版本刪除了這張圖片'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SourceBadgeFor({ entries, commit }: { entries: HistoryEntry[]; commit: string }) {
  const e = entries.find((x) => x.commit === commit);
  if (!e) return <span className="font-mono text-[12px] text-ink-3">{shortId(commit)}</span>;
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
      {versionLabel(e) ?? ''}
      <SourceBadge entry={e} />
    </span>
  );
}

function sizeText(c: FileChange): string {
  if (c.change === 'added') return formatBytes(c.after?.size ?? 0);
  if (c.change === 'deleted' || c.change === 'renamed') return formatBytes(c.before?.size ?? 0);
  const a = c.before?.size ?? 0;
  const b = c.after?.size ?? 0;
  const delta = b - a;
  return `${formatBytes(a)} → ${formatBytes(b)}（${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}）`;
}

function ChangeRow({
  projectId,
  from,
  to,
  change,
  defaultOpen,
}: {
  projectId: ProjectId;
  from: string;
  to: string;
  change: FileChange;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = change.change !== 'renamed';
  const meta = CHANGE[change.change];
  return (
    <li>
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left enabled:hover:bg-raised"
      >
        <Badge tone={meta.tone} className="w-11 justify-center">
          {meta.label}
        </Badge>
        <FileIcon className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink" title={change.path}>
          {change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}
        </span>
        <span className="shrink-0 text-[12px] text-ink-3">{sizeText(change)}</span>
        {expandable && (
          <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition-transform', !open && '-rotate-90')} />
        )}
      </button>
      {expandable && open && (
        <div className="flex flex-col gap-3 border-t border-line bg-canvas/50 px-3.5 py-3">
          {previewKindOf(change.path) === 'image' && (
            <ImagePair
              projectId={projectId}
              from={from}
              to={to}
              path={change.path}
              previousPath={change.previousPath ?? change.path}
              before={change.before !== null}
              after={change.after !== null}
            />
          )}
          <FileDiffView projectId={projectId} from={from} to={to} path={change.path} />
        </div>
      )}
    </li>
  );
}

const SUMMARY_TEXT: Record<Extract<FileDiff, { kind: 'summary' }>['reason'], string> = {
  binary: '這不是文字檔（例如圖片或字型），不顯示逐行差異；以大小與內容識別碼辨識是否相同。',
  'too-large': '檔案太大，不在這裡顯示逐行差異。保存的原始內容不受影響。',
  'too-complex': '差異太多，無法在時間內整理成逐行差異。保存的原始內容不受影響。',
  'not-a-file': '這是捷徑或子模組，不顯示內容差異。',
  identical: '兩個版本的內容相同。',
};

function FileSide({ label, file }: { label: string; file: TreeFile | null }) {
  return (
    <>
      <span className="text-ink-3">{label}</span>
      <span>{file ? `${file.size === null ? '' : formatBytes(file.size)} · ${shortId(file.oid)}` : '（不存在）'}</span>
    </>
  );
}

const EOL_LABEL = { lf: 'LF', crlf: 'CRLF（Windows）', mixed: '混合', none: '無換行' } as const;

function FileDiffView({ projectId, from, to, path }: { projectId: ProjectId; from: string; to: string; path: string }) {
  const diff = useFileDiff(projectId, from, to, path, true);
  if (diff.isError) return <ErrorNote error={diff.error} />;
  if (diff.isPending) return <p className="text-[12px] text-ink-3">讀取中…</p>;
  const d = diff.data;
  if (d.kind === 'summary') {
    return (
      <div className="grid gap-2 text-[12px] text-ink-2">
        <p>{SUMMARY_TEXT[d.reason]}</p>
        <div className="grid grid-cols-[64px_1fr] gap-x-4 gap-y-1">
          <FileSide label="之前" file={d.before} />
          <FileSide label="之後" file={d.after} />
        </div>
      </div>
    );
  }
  const notes: string[] = [];
  if (d.lineEndings.before && d.lineEndings.after && d.lineEndings.before !== d.lineEndings.after) {
    notes.push(`換行字元：${EOL_LABEL[d.lineEndings.before]} → ${EOL_LABEL[d.lineEndings.after]}`);
  }
  if (d.missingFinalNewline.before !== d.missingFinalNewline.after) notes.push('檔案結尾的換行有變動');
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-line bg-raised px-3 py-1.5 text-[12px] text-ink-3">
        <span className="text-ok">+{d.added} 行</span>
        <span className="text-danger">−{d.removed} 行</span>
        {notes.map((n) => (
          <span key={n}>{n}</span>
        ))}
        <span className="ml-auto">唯讀</span>
      </div>
      <div className="dt-scroll max-h-[480px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.65]">
          <tbody>
            {d.hunks.map((h, i) => (
              <Hunk key={i} hunk={h} />
            ))}
          </tbody>
        </table>
        {d.truncated && <p className="px-3 py-2 text-[12px] text-warn">差異太長，只顯示前面的部分。</p>}
        {d.hunks.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-3">文字內容相同。</p>}
      </div>
    </div>
  );
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
  let oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newNo = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-sunken/60 px-3 py-0.5 text-[11px] text-ink-3 select-none">
          第 {hunk.oldStart} 行起 → 第 {hunk.newStart} 行起
        </td>
      </tr>
      {hunk.lines.map((line, i) => {
        const op = line[0];
        const text = line.slice(1).replace(/\r$/, '');
        const cr = line.endsWith('\r');
        const o = op === '+' ? null : oldNo++;
        const n = op === '-' ? null : newNo++;
        return (
          <tr key={i} className={cn(op === '+' && 'bg-ok-soft', op === '-' && 'bg-danger-soft')}>
            <td className="w-10 border-r border-line/70 px-2 text-right align-top text-ink-3 select-none">{o ?? ''}</td>
            <td className="w-10 border-r border-line/70 px-2 text-right align-top text-ink-3 select-none">{n ?? ''}</td>
            <td
              className={cn(
                'w-5 text-center align-top select-none',
                op === '+' && 'text-ok',
                op === '-' && 'text-danger',
              )}
              aria-label={op === '+' ? '新增' : op === '-' ? '刪除' : undefined}
            >
              {op === '+' ? '+' : op === '-' ? '−' : ''}
            </td>
            <td className="pr-4 whitespace-pre text-ink">
              {text}
              {cr && <span className="text-ink-3 select-none">␍</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}
