import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border border-line bg-surface shadow-card', className)} {...rest} />;
}

export function SectionTitle({ className, ...rest }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-[13px] font-semibold tracking-wide text-ink-2', className)} {...rest} />;
}
