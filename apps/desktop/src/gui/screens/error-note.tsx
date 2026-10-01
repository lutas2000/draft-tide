import { DtError, type ErrorCode } from '@draft-tide/contracts';
import { Alert } from '../components/icons.tsx';

// Every error gets a reason and a next step in designer terms (M1 plan §4.1).
// The code is kept for diagnostics.
const COPY: Partial<Record<ErrorCode, { title: string; next: string }>> = {
  ENGINE_UNAVAILABLE: {
    title: '無法連線到 Draft Tide 引擎',
    next: '設計檔案與歷史不受影響。稍後重試，或重新開啟 Draft Tide。',
  },
  PROTOCOL_MISMATCH: { title: 'Draft Tide 的元件版本不一致', next: '請更新或重新開啟 Draft Tide。' },
  STORAGE_IO_FAILED: { title: '無法讀寫本機狀態', next: '沒有任何資料被刪除。請到「設定與診斷」查看詳情。' },
};

export function ErrorNote({ error }: { error: unknown }) {
  const code: ErrorCode = error instanceof DtError ? error.code : 'INTERNAL_ERROR';
  const copy = COPY[code] ?? { title: '發生未預期的錯誤', next: '設計檔案不受影響。請重試，若仍發生請匯出診斷資訊。' };
  return (
    <div
      className="flex gap-3 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-[13px] text-danger"
      role="alert"
    >
      <Alert className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">{copy.title}</p>
        <p className="mt-0.5 text-ink-2">{copy.next}</p>
        <p className="mt-1 font-mono text-[11px] text-ink-3">{code}</p>
      </div>
    </div>
  );
}
