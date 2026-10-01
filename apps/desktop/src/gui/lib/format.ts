// Display formatting. Machine timestamps stay UTC ISO strings everywhere else.
const dateTime = new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' });

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
