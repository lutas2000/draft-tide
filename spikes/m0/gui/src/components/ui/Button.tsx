import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger' | 'demo';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary:
    'bg-tide-600 text-white shadow-card hover:bg-tide-700 active:bg-tide-900 disabled:bg-tide-200 disabled:text-white disabled:shadow-none',
  secondary:
    'bg-surface text-ink border border-line-strong hover:bg-raised hover:border-ink-3 active:bg-sunken disabled:text-ink-3 disabled:border-line',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink active:bg-line disabled:text-ink-3 disabled:hover:bg-transparent',
  quiet: 'text-tide-600 hover:text-tide-700 hover:underline underline-offset-4 disabled:text-ink-3 px-0! h-auto!',
  danger: 'bg-danger text-white hover:brightness-95 active:brightness-90 disabled:opacity-50',
  demo: 'dt-demo text-ink-2 hover:text-ink hover:border-ink-3',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-sm',
  md: 'h-9 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-md',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none transition-colors duration-150 disabled:cursor-not-allowed',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
}
