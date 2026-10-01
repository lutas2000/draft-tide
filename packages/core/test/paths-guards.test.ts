import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareGitPaths, createProjectWriteGuards, findPathCollisions, mapLimit } from '../src/index.ts';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('compareGitPaths', () => {
  it('orders by UTF-8 bytes, as Git does', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
        const expected = Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)));
        expect(Math.sign(compareGitPaths(a, b))).toBe(expected);
      }),
    );
  });

  it('disagrees with UTF-16 order where Git does', () => {
    // U+FF5E (3 UTF-8 bytes) sorts before an emoji (4 bytes, a surrogate pair in UTF-16).
    expect(compareGitPaths('\u{ff5e}', '😀')).toBeLessThan(0);
    expect('\u{ff5e}' < '😀').toBe(false);
  });
});

describe('findPathCollisions', () => {
  it('finds case and Unicode normalization collisions, also on folders', () => {
    const nfc = 'café.html';
    const nfd = 'café.html';
    const groups = findPathCollisions(['A.txt', 'a.txt', nfc, nfd, 'Dir/x', 'dir/y', 'ok.txt']);
    expect(groups).toContainEqual(['A.txt', 'a.txt']);
    expect(groups).toContainEqual([nfd, nfc].sort(compareGitPaths));
    expect(groups).toContainEqual(['Dir', 'dir']);
    expect(groups.flat()).not.toContain('ok.txt');
  });

  it('finds nothing in distinct paths', () => {
    expect(findPathCollisions(['a/b', 'a/c', 'b', '定價/index.html'])).toEqual([]);
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('starts nothing after a failure and returns only when nothing is in flight', async () => {
    let started = 0;
    let finished = 0;
    const run = mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (i) => {
        started++;
        await tick();
        if (i === 1) throw new Error('boom');
        await tick();
        finished++;
      },
    );
    await expect(run).rejects.toThrow('boom');
    const settled = finished;
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(settled);
    expect(started).toBeLessThan(20);
  });

  it('stops at an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(mapLimit([1, 2], 1, (n) => Promise.resolve(n), ac.signal)).rejects.toThrow('stop');
  });
});

describe('project write guards', () => {
  it('runs writes for one project one at a time, in order', async () => {
    const guards = createProjectWriteGuards();
    const log: string[] = [];
    const write = (name: string, ms: number) =>
      guards.run('p1', async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([write('a', 15), write('b', 1), write('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('runs different projects concurrently', async () => {
    const guards = createProjectWriteGuards();
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = guards.run('p1', async () => {
      log.push('p1 start');
      await held;
      log.push('p1 end');
    });
    await guards.run('p2', () => {
      log.push('p2');
      return Promise.resolve();
    });
    release();
    await slow;
    expect(log).toEqual(['p1 start', 'p2', 'p1 end']);
  });

  it('releases the guard after a failure and reports busy only while work is queued', async () => {
    const guards = createProjectWriteGuards();
    const failed = guards.run('p1', async () => {
      await tick();
      throw new Error('write failed');
    });
    const next = guards.run('p1', () => Promise.resolve('next'));
    expect(guards.isBusy('p1')).toBe(true);
    expect(guards.isBusy('p2')).toBe(false);
    await expect(failed).rejects.toThrow('write failed');
    await expect(next).resolves.toBe('next');
    await tick();
    expect(guards.isBusy('p1')).toBe(false);
  });
});
