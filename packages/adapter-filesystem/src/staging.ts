import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DtError, OperationId, ProjectId } from '@draft-tide/contracts';
import type { GitOid, StagingArea } from '@draft-tide/core';
import { ioError } from './io.ts';
import { volumeSpace } from './space.ts';

const OID = /^[0-9a-f]{40}$/;

// Immutable staging for one operation, in the data directory and never in the
// project folder (TECH_STACK §6.3):
//   <data>/projects/<project-id>/operations/<operation-id>/staging/attempt-<n>/<blob id>
// Directories are 0700, staged files 0400 and written exclusively.
export async function createStagingArea(dataDir: string, projectId: string, operationId: string): Promise<StagingArea> {
  // Both become path components: only canonical UUIDs.
  if (!ProjectId.safeParse(projectId).success || !OperationId.safeParse(operationId).success) {
    throw new DtError('INTERNAL_ERROR', 'staging needs a project id and an operation id');
  }
  const dir = join(dataDir, 'projects', projectId, 'operations', operationId, 'staging');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw ioError(e, 'preparing staging', { volume: 'app-data' });
  }
  const attemptDir = (attempt: number) => {
    if (!Number.isInteger(attempt) || attempt < 1) throw new DtError('INTERNAL_ERROR', 'invalid capture attempt');
    return join(dir, `attempt-${attempt}`);
  };
  return {
    dir,
    async prepareAttempt(attempt) {
      const d = attemptDir(attempt);
      try {
        await rm(d, { recursive: true, force: true });
        await mkdir(d, { mode: 0o700 });
      } catch (e) {
        throw ioError(e, 'preparing staging', { volume: 'app-data' });
      }
    },
    pathFor(attempt: number, oid: GitOid) {
      if (!OID.test(oid)) throw new DtError('INTERNAL_ERROR', 'invalid object id');
      return join(attemptDir(attempt), oid);
    },
    async discardAttempt(attempt) {
      await rm(attemptDir(attempt), { recursive: true, force: true });
    },
    space: () => volumeSpace(dir),
    async remove() {
      await rm(dir, { recursive: true, force: true });
      // The operation folder goes too once nothing else of the operation is in it.
      await rmdir(dirname(dir)).catch(() => undefined);
    },
  };
}
