import type { EngineEvent } from '@draft-tide/contracts';
import { SAVE_STAGE_LABEL } from '../lib/copy.ts';
import { Spinner } from './icons.tsx';

type ProgressEvent = Extract<EngineEvent, { name: 'operation.progress' }>;

// What the Engine reports while saving: the stage and the files and bytes
// handled so far. No time estimate: it can't be made reliably.
export function SaveProgressLine({ event, fallback = '保存中…' }: { event: ProgressEvent | null; fallback?: string }) {
  const p = event?.progress;
  const share = p && p.bytesTotal > 0 ? Math.min(1, p.bytesDone / p.bytesTotal) : null;
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner />
        {p ? (SAVE_STAGE_LABEL[p.stage] ?? fallback) : fallback}
        {p && p.filesTotal > 0 && (
          <span className="text-ink-3">
            {p.filesDone} / {p.filesTotal}
          </span>
        )}
        {p && p.attempt > 1 && <span className="text-warn">（檔案有變動，第 {p.attempt} 次嘗試）</span>}
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-tide-500 transition-[width] duration-150"
          style={{ width: share === null ? '30%' : `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}
