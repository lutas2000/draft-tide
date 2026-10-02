import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className = 'size-4', ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function TideMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--color-tide-600)" />
      <path
        d="M6 19c3.2-3.4 6.4-3.4 9.6 0s6.8 3.4 10.4 0"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M6 13.5c3.2-3.4 6.4-3.4 9.6 0s6.8 3.4 10.4 0"
        fill="none"
        stroke="#fff"
        strokeOpacity=".55"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const Folder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2.2h8.6A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
  </Icon>
);

export const Sparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
    <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Icon>
);

export const Cloud = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 18.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9.2a4.25 4.25 0 0 1 .25 8.5V18.5z" />
  </Icon>
);

export const Gear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);

export const Layers = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
    <path d="M3.5 12.5L12 17l8.5-4.5" />
    <path d="M3.5 16.5L12 21l8.5-4.5" />
  </Icon>
);

export const Alert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4.5" />
    <path d="M12 17.5h.01" />
  </Icon>
);

export const Agent = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4.5V8" />
    <circle cx="9.5" cy="13.5" r=".9" fill="currentColor" />
    <circle cx="14.5" cy="13.5" r=".9" fill="currentColor" />
  </Icon>
);

export const ChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 6l-6 6 6 6" />
  </Icon>
);

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const Dot = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </Icon>
);

export const Save = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 4.5h11l3.5 3.5v11.5a1 1 0 0 1-1 1h-13.5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" />
    <path d="M8 4.5v5h7v-5" />
    <path d="M8 20v-6h8v6" />
  </Icon>
);

export const Columns = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
    <path d="M12 4.5v15" />
  </Icon>
);

export const FileIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
    <path d="M13.5 3.5v4h4" />
  </Icon>
);

// Back to an earlier version: an arrow turning counter-clockwise.
export const Undo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 9.5h10a5 5 0 0 1 0 10h-4" />
    <path d="M8.5 5.5l-4 4 4 4" />
  </Icon>
);

export const Branch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="6" r="2" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="17" cy="8" r="2" />
    <path d="M7 8v8" />
    <path d="M17 10c0 4-10 2-10 6" />
  </Icon>
);

export const Person = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5" />
  </Icon>
);

export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Icon>
);

export const Picture = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" />
  </Icon>
);

export const Expand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4.5h5.5V10" />
    <path d="M10 19.5H4.5V14" />
    <path d="m19.5 4.5-6 6" />
    <path d="m4.5 19.5 6-6" />
  </Icon>
);

export const Spinner = ({ className = 'size-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} animate-spin`}>
    <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
    <path
      d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);
