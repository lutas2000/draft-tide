import { Dialog as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

// A modal for a short task (naming a version). Escape and the close button
// dismiss it unless it is busy.
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  busy = false,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  // For a picture: nearly the whole window.
  wide?: boolean;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 animate-fade bg-scrim" />
        <Primitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 animate-rise rounded-xl border border-line bg-surface p-6 shadow-dialog',
            wide
              ? 'dt-scroll max-h-[calc(100vh-2rem)] w-[min(1240px,calc(100vw-2rem))] overflow-y-auto'
              : 'w-[min(520px,calc(100vw-2rem))]',
          )}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Primitive.Title className="text-[17px] font-semibold tracking-tight text-ink">{title}</Primitive.Title>
          {description ? (
            <Primitive.Description className="mt-1 text-[13px] text-ink-2">{description}</Primitive.Description>
          ) : (
            <Primitive.Description className="sr-only">{title}</Primitive.Description>
          )}
          <div className="mt-4">{children}</div>
          <div className="mt-6 flex justify-end gap-2">{footer}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
