import type { DesignRepo } from './repo.ts';

export function fastForwardOnly(repo: DesignRepo, target: string) {
  return repo.fastForward(target, { indexLockWaitMs: 300 });
}
