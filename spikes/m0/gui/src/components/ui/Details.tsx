import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDown } from '../Icons';

/** Accessible disclosure used for 「詳細資訊」 and file rows. */
export function Details({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-1.5 text-left text-[13px] text-ink-2 hover:text-ink', summaryClassName)}
      >
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
        {summary}
      </button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}

/** Key / value rows for diagnostics-style details (IDs live only here). */
export function MetaList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 font-mono break-all text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
