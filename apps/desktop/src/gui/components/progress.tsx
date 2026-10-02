import { RECOVERY_STAGE_LABEL, RESTORE_STAGE_LABEL, SAVE_STAGE_LABEL } from '../lib/copy.ts';
import type { ProgressEvent } from '../lib/engine-state.ts';
import { Spinner } from './icons.tsx';

const STAGE_LABELS: Record<ProgressEvent['operation'], Record<string, string>> = {
  'snapshot.create': SAVE_STAGE_LABEL,
  'restore.apply': RESTORE_STAGE_LABEL,
  'recovery.apply': RECOVERY_STAGE_LABEL,
};

// What the Engine reports while it saves, restores or recovers: the stage and
// the files and bytes handled so far. No time estimate: it can't be made
// reliably. The bar follows bytes when the stage counts them, else files.
export function ProgressLine({ event, fallback }: { event: ProgressEvent | null; fallback: string }) {
  const p = event?.progress;
  const share =
    p && p.bytesTotal > 0
      ? Math.min(1, p.bytesDone / p.bytesTotal)
      : p && p.filesTotal > 0
        ? Math.min(1, p.filesDone / p.filesTotal)
        : null;
  // Only a save's capture retries when files change under it.
  const attempt = p && 'attempt' in p ? p.attempt : 1;
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner />
        {event && p ? (STAGE_LABELS[event.operation][p.stage] ?? fallback) : fallback}
        {p && p.filesTotal > 0 && (
          <span className="text-ink-3">
            {p.filesDone} / {p.filesTotal}
          </span>
        )}
        {attempt > 1 && <span className="text-warn">（檔案有變動，第 {attempt} 次嘗試）</span>}
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
