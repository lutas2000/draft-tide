import { AlertDialog as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';

// A confirmation the user must answer. Escape and the cancel button both
// decline; there is no click-outside dismissal.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel = '取消',
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 animate-fade bg-scrim" />
        <Primitive.Content className="fixed top-1/2 left-1/2 z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 animate-rise rounded-xl border border-line bg-surface p-6 shadow-dialog">
          <Primitive.Title className="text-[17px] font-semibold tracking-tight text-ink">{title}</Primitive.Title>
          <Primitive.Description asChild>
            <div className="mt-3 text-[14px] text-ink-2">{children}</div>
          </Primitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Primitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </Primitive.Cancel>
            <Button variant="primary" onClick={onConfirm} disabled={busy}>
              {confirmLabel}
            </Button>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
