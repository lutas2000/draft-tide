import type { SVGProps } from 'react';
import { cn } from '../lib/cn';

type P = SVGProps<SVGSVGElement>;

/** Default to 16px unless the caller passes its own size-* class. */
function iconClass(className: string | undefined): string {
  return /(^|\s)size-/.test(className ?? '') ? cn('shrink-0', className) : cn('size-4 shrink-0', className);
}

function Svg({ children, className, ...props }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
      className={iconClass(className)}
    >
      {children}
    </svg>
  );
}

export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Svg>
);
export const Sparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" />
    <path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);
export const ChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 6l-6 6 6 6" />
  </Svg>
);
export const ChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 6l6 6-6 6" />
  </Svg>
);
export const ChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const Alert = (p: P) => (
  <Svg {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4.5M12 17.2v.3" />
  </Svg>
);
export const Info = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.3" />
  </Svg>
);
export const Gear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
  </Svg>
);
export const Archive = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
    <path d="M5 8.5v9A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-9M10 12.5h4" />
  </Svg>
);
export const Columns = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="7.5" height="14" rx="1.5" />
    <rect x="13" y="5" width="7.5" height="14" rx="1.5" />
  </Svg>
);
export const Restore = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9" />
  </Svg>
);
export const Shield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6.3z" />
  </Svg>
);
export const Bot = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="8" width="14" height="10.5" rx="3" />
    <path d="M12 4.5V8M9.5 13v.5M14.5 13v.5" />
  </Svg>
);
export const Flag = (p: P) => (
  <Svg {...p}>
    <path d="M6 20.5V4.5M6 5h10.5l-2 3.5 2 3.5H6" />
  </Svg>
);
export const Save = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5h11l3.5 3.5v11A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5z" />
    <path d="M8 4.5v4.5h7V4.5M8 20.5v-6h8v6" />
  </Svg>
);
export const Close = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5" />
  </Svg>
);
export const Swap = (p: P) => (
  <Svg {...p}>
    <path d="M7 7.5h12l-3.5-3.5M17 16.5H5l3.5 3.5" />
  </Svg>
);
export const Compass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
  </Svg>
);
export const File = (p: P) => (
  <Svg {...p}>
    <path d="M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
    <path d="M13.5 3.5V8.5H18.5" />
  </Svg>
);
export const ImageIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8 8" />
  </Svg>
);
export const Link = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
  </Svg>
);
export const Pencil = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5z" />
  </Svg>
);
export const Clock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const Terminal = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <path d="M7.5 10l2.5 2-2.5 2M12.5 15h4" />
  </Svg>
);
export const Expand = (p: P) => (
  <Svg {...p}>
    <path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6" />
  </Svg>
);
export const Spinner = (p: P) => (
  <Svg {...p} className={cn('animate-spin', p.className)}>
    <path d="M12 4a8 8 0 1 1-8 8" />
  </Svg>
);
export const Dot = (p: P) => (
  <svg viewBox="0 0 8 8" aria-hidden="true" {...p} className={cn('size-2 shrink-0', p.className)}>
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
);

export function TideMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--color-tide-600)" />
      <path d="M6 19c3.2-3.4 6.4-3.4 9.6 0s6.8 3.4 10.4 0" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M6 13.5c3.2-3.4 6.4-3.4 9.6 0s6.8 3.4 10.4 0" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
