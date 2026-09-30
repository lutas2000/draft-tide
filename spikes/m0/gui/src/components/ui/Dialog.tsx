import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Close } from '../Icons';

/**
 * Modal dialog: portal to <body>, focus trapped, Esc / backdrop cancel (unless
 * `dismissible` is false, e.g. while files are being written), background made
 * inert, focus restored to the opener on close. Supports stacking.
 */

const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function setBackgroundInert(inert: boolean) {
  const root = document.getElementById('root');
  if (!root) return;
  if (inert) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Visually marks prototype-only dialogs (e.g. simulated system pickers). */
  simulated?: string;
  tone?: 'default' | 'danger' | 'warn';
}

const widths = { sm: 'max-w-[420px]', md: 'max-w-[520px]', lg: 'max-w-[680px]', xl: 'max-w-[1040px]' } as const;

export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return createPortal(<DialogPanel {...props} />, document.body);
}

function DialogPanel({
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  initialFocusRef,
  simulated,
  tone = 'default',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const token = Symbol('dialog');
    stack.push(token);
    setBackgroundInert(true);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>('[data-autofocus]') ?? null;
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token || !panel) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      } else if (!panel.contains(active)) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const idx = stack.indexOf(token);
      if (idx >= 0) stack.splice(idx, 1);
      if (stack.length === 0) setBackgroundInert(false);
      // Restore focus after the portal unmounts.
      requestAnimationFrame(() => {
        if (opener && document.contains(opener)) opener.focus();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-[1.5px]"
        aria-hidden="true"
        onMouseDown={() => {
          if (dismissible) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[calc(100vh-48px)] w-full animate-rise flex-col overflow-hidden rounded-xl bg-surface shadow-dialog outline-none',
          widths[size],
          tone === 'danger' && 'ring-1 ring-danger-line',
          tone === 'warn' && 'ring-1 ring-warn-line',
        )}
      >
        {simulated && (
          <div className="border-b border-dashed border-line-strong bg-raised px-6 py-1.5 text-[12px] text-ink-3">{simulated}</div>
        )}
        <div className="flex items-start gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[17px] leading-snug font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-ink-2">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              className="-mt-1 -mr-2 grid size-8 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink"
              aria-label="關閉"
            >
              <Close />
            </button>
          )}
        </div>
        {children && <div className="dt-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-raised px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}
