import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function Card({ className, ...rest }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border border-line bg-surface shadow-card', className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-4 px-5 pt-4 pb-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...rest} />;
}
