const utf8 = new TextEncoder();

// Git orders paths by their UTF-8 bytes. JavaScript's < compares UTF-16 code
// units, which disagrees for characters outside the BMP (emoji).
export function compareGitPaths(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

// Groups of paths that would name the same entry on a case-insensitive or
// normalization-insensitive filesystem (the APFS and NTFS defaults). Checked
// per prefix, so `A/x` and `a/y` collide on the directory. Saving them would
// work, but restoring them on another computer could not (M1 plan §6.2).
export function findPathCollisions(paths: Iterable<string>): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const p of paths) {
    let prefix = '';
    for (const part of p.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = prefix.normalize('NFC').toLowerCase();
      let group = byKey.get(key);
      if (!group) byKey.set(key, (group = new Set()));
      group.add(prefix);
    }
  }
  return [...byKey.values()].filter((g) => g.size > 1).map((g) => [...g].sort(compareGitPaths));
}

// Runs fn over items with at most `limit` in flight; results keep input order.
// After the first failure no new item starts, and it returns (or throws) only
// once nothing is in flight, so callers can clean up safely.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        signal?.throwIfAborted();
        out[i] = await fn(items[i] as T, i);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return out;
}
