import { DtError } from '@draft-tide/contracts';
import { Alert } from '../components/icons.tsx';
import { cn } from '../lib/cn.ts';
import { errorCopy } from '../lib/copy.ts';

// Every error gets a reason and a next step in designer terms (M1 plan §4.1).
// The code is kept for diagnostics. NO_CHANGES and CANCELLED (the user asked
// to stop) are notices, not failures.
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const code = error instanceof DtError ? error.code : 'INTERNAL_ERROR';
  const details = error instanceof DtError ? error.details : {};
  const copy = errorCopy(code, details);
  const calm = code === 'NO_CHANGES' || code === 'CANCELLED';
  return (
    <div
      className={cn(
        'flex gap-3 rounded-lg border px-4 py-3 text-[13px]',
        calm ? 'border-line bg-raised text-ink' : 'border-danger-line bg-danger-soft text-danger',
        className,
      )}
      role={calm ? 'status' : 'alert'}
    >
      <Alert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{copy.title}</p>
        <p className="mt-0.5 text-ink-2">{copy.next}</p>
        <p className="mt-1 font-mono text-[11px] text-ink-3">{code}</p>
      </div>
    </div>
  );
}
