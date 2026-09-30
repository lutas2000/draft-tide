const KB = 1000;

/** Finder-style decimal units (KB = 1000 B). */
export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < KB) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / KB;
  let unit: (typeof units)[number] = 'KB';
  for (let i = 1; i < units.length && Math.abs(value) >= KB; i++) {
    value /= KB;
    unit = units[i] ?? unit;
  }
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

export function formatByteDelta(delta: number): string {
  if (delta === 0) return '大小不變';
  return `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`;
}

const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Short local label for cards: 剛剛 / 12 分鐘前 / 今天 14:05 / 昨天 18:20 / 9月28日 10:12 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return '剛剛';
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return `今天 ${timeFmt.format(d)}`;
  if (dayDiff === 1) return `昨天 ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

export function formatFull(iso: string): string {
  return fullFmt.format(new Date(iso));
}

export function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60000).toISOString();
}

export function plural(n: number, unit: string): string {
  return `${n.toLocaleString('zh-TW')} ${unit}`;
}
