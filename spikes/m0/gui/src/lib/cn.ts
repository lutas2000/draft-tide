/** Joins truthy class names. Tiny stand-in for clsx; no dependency needed. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
