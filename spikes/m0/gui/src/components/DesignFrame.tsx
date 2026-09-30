import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { composePreview } from '../mock/designs';
import type { FileSet, PreviewStatus } from '../mock/types';
import { Alert } from './Icons';

export const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Renders a snapshot's entry page in a fully sandboxed iframe (no scripts, no
 * same-origin, CSP blocks network) at the fixed M1 viewport, scaled to fit.
 */
export function DesignFrame({
  files,
  entry,
  title,
  status = 'ready',
  className,
  rounded = true,
}: {
  files: FileSet;
  entry: string;
  title: string;
  status?: PreviewStatus;
  className?: string;
  rounded?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const html = useMemo(() => (status === 'ready' ? composePreview(files, entry) : null), [files, entry, status]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = width / VIEWPORT.width;

  return (
    <div
      ref={box}
      className={cn('relative aspect-[16/10] w-full overflow-hidden bg-sunken', rounded && 'rounded-md', className)}
    >
      {status === 'pending' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2 text-[12px] text-ink-3">
            <div className="h-2 w-24 animate-pulse-soft rounded-full bg-line" />
            預覽產生中…
          </div>
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 grid place-items-center p-3 text-center text-[12px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Alert className="size-3.5" />
            預覽無法產生；版本已保存，不受影響
          </span>
        </div>
      )}
      {status === 'ready' && html === null && (
        <div className="absolute inset-0 grid place-items-center p-3 text-center text-[12px] text-ink-3">
          找不到入口檔案 {entry}，無法預覽
        </div>
      )}
      {html !== null && width > 0 && (
        <iframe
          title={title}
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          aria-hidden="true"
          referrerPolicy="no-referrer"
          width={VIEWPORT.width}
          height={VIEWPORT.height}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-white"
          style={{ transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}
