import { useState, type ReactNode } from 'react';
import { DtError, type PreviewArtifact, type ProjectId } from '@draft-tide/contracts';
import { cn } from '../lib/cn.ts';
import {
  PREVIEW_BLOCKED_COPY,
  PREVIEW_FAILED_COPY,
  PREVIEW_MISSING_COPY,
  PREVIEW_UNSUPPORTED_COPY,
  errorCopy,
} from '../lib/copy.ts';
import { formatFull } from '../lib/format.ts';
import { usePreview, usePreviewImage, useSeen } from '../lib/preview.ts';
import { Alert, Expand, Picture, Spinner } from './icons.tsx';
import { Button } from './ui/button.tsx';
import { Details } from './ui/details.tsx';
import { Dialog } from './ui/dialog.tsx';

// Pictures of versions (M1 plan §8): rendered offline by the isolated
// Preview Host, at 1280×800, with the network off. A preview is never the
// version: when one can't be made, the version is still there and says so.

interface Problem {
  title: string;
  text: string;
  // A render that may work if asked again.
  retry: boolean;
  tone: 'quiet' | 'warn';
}

function problemOf(error: unknown): Problem {
  if (error instanceof DtError && error.code === 'PREVIEW_UNSUPPORTED') {
    const reason = error.details['reason'] as keyof typeof PREVIEW_UNSUPPORTED_COPY | undefined;
    return {
      title: '沒有可以預覽的畫面',
      text: (reason && PREVIEW_UNSUPPORTED_COPY[reason]) ?? '這個版本沒有可以預覽的畫面。',
      retry: false,
      tone: 'quiet',
    };
  }
  if (error instanceof DtError && error.code === 'PREVIEW_FAILED') {
    const reason = error.details['reason'] as keyof typeof PREVIEW_FAILED_COPY | undefined;
    return {
      title: '無法產生預覽',
      text: `${(reason && PREVIEW_FAILED_COPY[reason]) ?? '預覽沒有完成。'}版本本身不受影響。`,
      retry: reason !== 'no-renderer',
      tone: 'warn',
    };
  }
  const code = error instanceof DtError ? error.code : 'INTERNAL_ERROR';
  const copy = errorCopy(code, error instanceof DtError ? error.details : {});
  return { title: copy.title, text: copy.next, retry: true, tone: 'warn' };
}

// What the page asked for and didn't get, in one line.
export function incompleteText(art: PreviewArtifact): string | null {
  const parts: string[] = [];
  if (art.missing.count > 0) parts.push(`缺少 ${art.missing.count} 個檔案`);
  if (art.blocked.count > 0) parts.push(`擋下 ${art.blocked.count} 個外部連線或動作`);
  return parts.length > 0 ? parts.join('，') : null;
}

// ---- A thumbnail in a history row (rendered once the row is on screen)

export function PreviewThumb({ projectId, version, label }: { projectId: ProjectId; version: string; label: string }) {
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const preview = usePreview(projectId, version, { enabled: seen });
  const image = usePreviewImage(preview.data, 'thumbnail', { ref: version });
  const problem = preview.isError ? problemOf(preview.error) : null;
  return (
    <span
      ref={ref}
      className="relative grid h-[45px] w-[72px] shrink-0 place-items-center overflow-hidden rounded-sm border border-line bg-sunken"
      title={problem ? `${problem.title}：${problem.text}` : undefined}
    >
      {image.data ? (
        <img src={image.data} alt={`${label} 的畫面縮圖`} className="size-full object-cover object-top" />
      ) : problem ? (
        problem.tone === 'warn' ? (
          <Alert className="size-4 text-warn" aria-label="無法產生預覽" />
        ) : (
          <Picture className="size-4 text-ink-3" aria-label="沒有預覽" />
        )
      ) : (
        <Spinner className="size-3.5 text-ink-3" />
      )}
    </span>
  );
}

// ---- A picture with its state

function Frame({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <div
      className={cn(
        'relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-md border border-line bg-sunken',
        className,
      )}
    >
      {children}
    </div>
  );
}

function ProblemBox({ problem, onRetry }: { problem: Problem; onRetry?: () => void }) {
  return (
    <div className="flex max-w-[80%] flex-col items-center gap-1.5 px-3 text-center" role="status">
      {problem.tone === 'warn' ? <Alert className="size-5 text-warn" /> : <Picture className="size-5 text-ink-3" />}
      <p className={cn('text-[13px] font-medium', problem.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>
        {problem.title}
      </p>
      <p className="text-[12px] text-ink-3">{problem.text}</p>
      {problem.retry && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          再試一次
        </Button>
      )}
    </div>
  );
}

// The full picture of a version (or one of its images). `file` previews a
// PNG/JPEG of the version instead of its entry page.
export function PreviewFigure({
  projectId,
  version,
  file,
  label,
  onOpen,
  className,
}: {
  projectId: ProjectId;
  version: string;
  file?: string;
  label: string;
  onOpen?: (art: PreviewArtifact) => void;
  className?: string;
}) {
  const preview = usePreview(projectId, version, file !== undefined ? { file } : {});
  const image = usePreviewImage(preview.data, 'full', { ref: version, ...(file !== undefined ? { file } : {}) });
  const art = preview.data;
  const failed = preview.isError ? preview.error : image.isError ? image.error : null;
  const notes = art ? incompleteText(art) : null;
  return (
    <figure className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Frame className={art?.subject.kind === 'image' ? 'bg-white' : undefined}>
        {image.data && art ? (
          <button
            type="button"
            className="group size-full cursor-zoom-in"
            onClick={() => onOpen?.(art)}
            disabled={!onOpen}
            aria-label={`放大 ${label} 的畫面`}
          >
            <img
              src={image.data}
              alt={`${label} 的畫面預覽`}
              className={cn('size-full', art.subject.kind === 'image' ? 'object-contain' : 'object-cover object-top')}
            />
            {onOpen && (
              <Expand className="absolute top-2 right-2 size-6 rounded-sm bg-surface/90 p-1 text-ink-2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        ) : failed ? (
          <ProblemBox
            problem={problemOf(failed)}
            onRetry={() => {
              void preview.refetch();
              void image.refetch();
            }}
          />
        ) : (
          <span className="flex items-center gap-2 text-[12px] text-ink-3" role="status">
            <Spinner className="size-3.5" />
            產生預覽…
          </span>
        )}
      </Frame>
      {notes && (
        <figcaption className="flex items-center gap-1.5 text-[12px] text-warn">
          <Alert className="size-3.5 shrink-0" />
          {notes}
          {onOpen && art && (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpen(art)}>
              查看
            </button>
          )}
        </figcaption>
      )}
    </figure>
  );
}

// ---- What the preview missed, and how it was made

export function PreviewNotes({ art }: { art: PreviewArtifact }) {
  const env = art.environment;
  const s = art.settings;
  return (
    <div className="flex flex-col gap-3 text-[12px] text-ink-2">
      {art.incomplete ? (
        <div className="rounded-md bg-warn-soft px-3 py-2">
          <p className="font-medium text-warn">預覽可能和你在瀏覽器看到的不同</p>
          <p className="mt-0.5">
            預覽在離線、與外部隔離的環境中產生：頁面需要但版本裡沒有的檔案，以及外部網站的字型、圖片或資料都不會出現。
          </p>
          {art.missing.count > 0 && (
            <div className="mt-2">
              <p className="font-medium text-ink">缺少的檔案（{art.missing.count}）</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {art.missing.entries.map((m, i) => (
                  <li key={i} className="truncate">
                    <span className="font-mono">{m.path || '（空白路徑）'}</span>
                    <span className="text-ink-3"> · {PREVIEW_MISSING_COPY[m.reason]}</span>
                  </li>
                ))}
                {art.missing.count > art.missing.entries.length && (
                  <li className="text-ink-3">另外 {art.missing.count - art.missing.entries.length} 個…</li>
                )}
              </ul>
            </div>
          )}
          {art.blocked.count > 0 && (
            <div className="mt-2">
              <p className="font-medium text-ink">擋下的外部連線與動作（{art.blocked.count}）</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {art.blocked.entries.map((b, i) => (
                  <li key={i} className="truncate">
                    <span className="text-ink-3">{PREVIEW_BLOCKED_COPY[b.kind]} · </span>
                    <span className="font-mono">{b.target}</span>
                  </li>
                ))}
                {art.blocked.count > art.blocked.entries.length && (
                  <li className="text-ink-3">另外 {art.blocked.count - art.blocked.entries.length} 個…</li>
                )}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-ink-3">頁面需要的檔案都在版本裡，也沒有被擋下的外部連線。</p>
      )}
      <Details summary="預覽的產生方式">
        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1">
          <dt className="text-ink-3">內容</dt>
          <dd className="break-all">
            {art.subject.kind === 'page' ? `預覽頁面 ${art.subject.path}` : `圖片 ${art.subject.path}`}
            {art.subject.kind === 'image' && `（原始大小 ${art.subject.width}×${art.subject.height}）`}
          </dd>
          <dt className="text-ink-3">畫面大小</dt>
          <dd>
            {art.image.width}×{art.image.height}
            {art.subject.kind === 'page' &&
              `（固定視窗 ${s.viewport.width}×${s.viewport.height}，縮放 ${s.viewport.scale}）`}
          </dd>
          <dt className="text-ink-3">產生時間</dt>
          <dd>{formatFull(art.renderedAt)}</dd>
          <dt className="text-ink-3">瀏覽器核心</dt>
          <dd className="break-all">
            Chromium {env.chromium}（Electron {env.electron}）
          </dd>
          <dt className="text-ink-3">系統</dt>
          <dd>
            {env.platform} {env.osRelease}（使用這台電腦的字型）
          </dd>
          <dt className="text-ink-3">語系與時區</dt>
          <dd>
            {s.locale} · {s.timezone}
          </dd>
          <dt className="text-ink-3">等待與動畫</dt>
          <dd>
            載入完成、字型就緒後再等一下才擷取；動畫直接跳到結束狀態。腳本{s.scripts ? '會' : '不會'}
            執行，網路一律關閉。
          </dd>
        </dl>
      </Details>
    </div>
  );
}

// ---- Enlarged

export function PreviewDialog({
  art,
  title,
  open,
  onOpenChange,
  version,
  file,
}: {
  art: PreviewArtifact | null;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
  file?: string;
}) {
  const image = usePreviewImage(art ?? undefined, 'full', { ref: version, ...(file !== undefined ? { file } : {}) });
  return (
    <Dialog
      wide
      open={open && art !== null}
      onOpenChange={onOpenChange}
      title={title}
      description="以 1280×800 的固定視窗、在離線且與外部隔離的環境中產生的畫面。"
      footer={<Button onClick={() => onOpenChange(false)}>關閉</Button>}
    >
      {art && (
        <div className="flex flex-col gap-4">
          <div
            className={cn(
              'overflow-hidden rounded-md border border-line',
              art.subject.kind === 'image' ? 'bg-white' : 'bg-sunken',
            )}
          >
            {image.data ? (
              <img
                src={image.data}
                alt={`${title} 的畫面預覽`}
                className="mx-auto block h-auto max-h-[min(70vh,800px)] w-auto max-w-full"
              />
            ) : (
              <div className="grid aspect-[16/10] place-items-center text-[12px] text-ink-3">
                <Spinner className="size-4" />
              </div>
            )}
          </div>
          <PreviewNotes art={art} />
        </div>
      )}
    </Dialog>
  );
}

// A figure that opens its own dialog.
export function PreviewWithDialog(props: {
  projectId: ProjectId;
  version: string;
  file?: string;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState<PreviewArtifact | null>(null);
  return (
    <>
      <PreviewFigure {...props} onOpen={setOpen} />
      <PreviewDialog
        art={open}
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        title={props.file !== undefined ? `${props.label} · ${props.file}` : props.label}
        version={props.version}
        {...(props.file !== undefined ? { file: props.file } : {})}
      />
    </>
  );
}
