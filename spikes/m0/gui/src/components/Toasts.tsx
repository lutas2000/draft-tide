import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import { useStore, type Toast } from '../state/store';
import { Check, Close, Info, Alert } from './Icons';

export function Toasts() {
  const { state } = useStore();
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-[440px] -translate-x-1/2 flex-col gap-2"
    >
      {state.toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const { dispatch } = useStore();
  useEffect(() => {
    const t = window.setTimeout(() => dispatch({ type: 'dismissToast', id: toast.id }), 5200);
    return () => window.clearTimeout(t);
  }, [toast.id, dispatch]);
  const Icon = toast.tone === 'ok' ? Check : toast.tone === 'warn' ? Alert : Info;
  return (
    <div className="pointer-events-auto flex animate-rise items-start gap-3 rounded-lg bg-ink px-4 py-3 text-white shadow-dialog">
      <Icon className={cn('mt-0.5 size-4', toast.tone === 'ok' && 'text-tide-200', toast.tone === 'warn' && 'text-warn-line')} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.body && <p className="mt-0.5 text-[13px] text-white/75">{toast.body}</p>}
      </div>
      <button
        type="button"
        onClick={() => dispatch({ type: 'dismissToast', id: toast.id })}
        className="-mr-1 grid size-6 place-items-center rounded-sm text-white/60 hover:text-white"
        aria-label="關閉通知"
      >
        <Close className="size-3.5" />
      </button>
    </div>
  );
}
