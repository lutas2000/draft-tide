// Per-project write serialization inside the one Engine (CLAUDE.md "Single
// writer"). The cross-process Engine lock keeps it to one writer per data
// store; these guards keep it to one write at a time per project, whichever
// channel asked. Writes to different projects run concurrently.
//
// A failed write releases the guard like a successful one: the next write
// starts from whatever state Git and the journal record, never from an
// assumption about the previous one.
export interface ProjectWriteGuards {
  // Runs fn once every earlier write for this project has settled.
  run<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
  // Whether a write for this project is running or queued.
  isBusy(projectId: string): boolean;
}

export function createProjectWriteGuards(): ProjectWriteGuards {
  const tails = new Map<string, { tail: Promise<void>; pending: number }>();
  return {
    run<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
      const entry = tails.get(projectId) ?? { tail: Promise.resolve(), pending: 0 };
      entry.pending++;
      const result = entry.tail.then(fn);
      entry.tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(projectId, entry);
      void entry.tail.then(() => {
        entry.pending--;
        if (entry.pending === 0 && tails.get(projectId) === entry) tails.delete(projectId);
      });
      return result;
    },
    isBusy(projectId) {
      return (tails.get(projectId)?.pending ?? 0) > 0;
    },
  };
}
