import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone =
  | 'neutral'
  | 'tide'
  | 'agent'
  | 'protect'
  | 'restore'
  | 'baseline'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'outline';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-ink-2',
  tide: 'bg-tide-50 text-tide-700',
  agent: 'bg-agent-soft text-agent',
  protect: 'bg-protect-soft text-protect',
  restore: 'bg-restore-soft text-restore',
  baseline: 'bg-baseline-soft text-baseline',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  outline: 'border border-line-strong text-ink-2',
};

export function Badge({ tone = 'neutral', icon, children, className }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] leading-none font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
