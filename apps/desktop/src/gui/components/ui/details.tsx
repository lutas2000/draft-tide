import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { ChevronDown } from '../icons.tsx';

// A disclosure for diagnostics and long lists: closed by default.
export function Details({
  summary,
  children,
  className,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={cn('group', className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
