import {
  DtError,
  PROJECT_CONFIG_FILE,
  SNAPSHOT_METADATA_SCHEMA_VERSION,
  SnapshotId,
  SnapshotName,
  formatCommitMessage,
  type CommitIdentity,
  type IsoTimestamp,
  type OperationId,
  type Origin,
  type SaveProgress,
  type SaveStage,
  type SnapshotKind,
  type SnapshotMetadata,
} from '@draft-tide/contracts';
import { captureScope, type CaptureOptions } from './capture.ts';
import type { Clock, GitOid, ProjectGit } from './ports.ts';
import { assertUsable } from './scope.ts';

// Saving a version (M1 plan §7.1), run under the project's write guard:
//
//   1. probe the repo; refuse its blockers, and an earlier publish that
//      didn't finish (its lock is still in `.git`);
//   2. capture the scope (steps 3–5, capture.ts);
//   3. write only the content Git didn't have, from the immutable staged
//      copies, and check every id;
//   4. build the version's tree in a temporary index;
//   5. an unchanged tree is NO_CHANGES: no version that only changes the time
//      or the name;
//   6. commit on top of the tip the save started from, with the metadata;
//   7. publish lock-first (§9.3.1): LOCKED or HISTORY_CHANGED leave
//      everything as it was; RECOVERY_REQUIRED means the version is in
//      history and only the index switch is left.
//
// Nothing here writes a working file. The journal that lets recovery match a
// cut-short publish to its operation arrives with M1-05; the lock's content
// and the commit metadata both carry the operation id meanwhile.

export interface SaveOptions extends Omit<CaptureOptions, 'repo' | 'probe' | 'onProgress'> {
  repo: ProjectGit;
  // Names the staging, the temporary index and the lock; goes into metadata.
  operationId: OperationId;
  origin: Origin;
  name?: string | undefined;
  identity: CommitIdentity;
  clock: Clock;
  onProgress?: (progress: SaveProgress) => void;
  lockWaitMs?: number;
}

export interface SavedSnapshot {
  snapshotId: SnapshotId;
  kind: SnapshotKind;
  createdAt: IsoTimestamp;
  commit: GitOid;
  tree: GitOid;
  // The tip the version was built on; null for the first commit of a branch.
  parent: GitOid | null;
  branch: string;
  files: number;
  bytes: number;
  // Content Git didn't have before this save, deduplicated.
  newObjects: number;
  newBytes: number;
  attempts: number;
}

// baseline: the first version Draft Tide makes in this repo, the one that
// brings `.drafttide.json` in. After that, a save from the GUI is manual and
// one through the tool channel is agent-requested (which proves nothing about
// the agent's task).
function kindFor(origin: Origin, adopted: boolean): SnapshotKind {
  if (!adopted) return 'baseline';
  return origin === 'gui' ? 'manual' : 'agent-requested';
}

export async function saveSnapshot(options: SaveOptions): Promise<SavedSnapshot> {
  try {
    return await save(options);
  } finally {
    // The staged bytes are in Git now, or the save didn't happen; either way
    // nothing needs them. Leftovers (a failed removal) hold no state and are
    // cleaned with the operation's folder.
    await options.staging.remove().catch(() => undefined);
  }
}

async function save(options: SaveOptions): Promise<SavedSnapshot> {
  const { repo, operationId, origin, identity, clock, signal, onProgress } = options;
  const named = SnapshotName.safeParse(options.name ?? '');
  if (!named.success)
    throw new DtError('INVALID_ARGUMENT', 'the version name must be a single line of up to 200 characters');
  const name = named.data.trim();

  // 1.
  const probe = await repo.probe(signal);
  assertUsable(probe);
  if (!probe.hasRepo || probe.headRef === null || probe.branch === null) {
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the design folder's history (.git) is missing", {
      reason: 'repo-missing',
    });
  }
  const lock = await repo.indexLock();
  if (lock.held && lock.by === 'draft-tide') {
    throw new DtError('RECOVERY_REQUIRED', "an earlier change didn't finish switching Git's index; complete it first", {
      operationId: lock.operationId,
    });
  }

  // 2.
  const capture = await captureScope({ ...options, repo, probe, onProgress: (p) => onProgress?.(p) });
  const report = (stage: SaveStage, filesDone: number, filesTotal: number, bytesDone: number, bytesTotal: number) =>
    onProgress?.({ stage, attempt: capture.attempts, filesDone, filesTotal, bytesDone, bytesTotal });

  // 3. Identical content in several files was staged once.
  const toWrite = new Map<string, { oid: GitOid; size: number }>();
  for (const f of capture.files) if (f.staged !== null) toWrite.set(f.staged, { oid: f.oid, size: f.size });
  const blobs = [...toWrite];
  let bytesDone = 0;
  report('write', 0, blobs.length, 0, capture.newBytes);
  const written = await repo.writeBlobs(
    blobs.map(([path]) => path),
    (i) => {
      bytesDone += blobs[i]?.[1].size ?? 0;
      report('write', i + 1, blobs.length, bytesDone, capture.newBytes);
    },
    signal,
  );
  const wrong = blobs.findIndex(([, b], i) => written[i] !== b.oid);
  if (wrong !== -1) throw new DtError('GIT_FAILED', 'Git stored different content than was captured');

  // 4.
  const tree = await repo.prepareIndex(
    operationId,
    capture.files.map((f) => ({ path: f.path, mode: f.mode, oid: f.oid })),
    signal,
  );

  // 5. and 6. Until publish starts, a failure leaves only objects behind
  // (unreferenced, Git prunes them in time) and the prepared index goes.
  const tip = probe.tip;
  let saved: Omit<SavedSnapshot, 'files' | 'bytes' | 'newObjects' | 'newBytes' | 'attempts'>;
  try {
    let tipTree: GitOid | null = null;
    if (tip !== null) {
      const [head] = await repo.readCommits([tip], signal);
      tipTree = head?.tree ?? null;
    }
    if (tipTree === tree) throw new DtError('NO_CHANGES', 'nothing changed since the last version', { commit: tip });
    const adopted = tipTree !== null && (await repo.lookupPath(tipTree, PROJECT_CONFIG_FILE, signal)) !== null;
    const kind = kindFor(origin, adopted);
    const createdAt = clock.nowIso();
    const metadata: SnapshotMetadata = {
      schemaVersion: SNAPSHOT_METADATA_SCHEMA_VERSION,
      snapshotId: SnapshotId.parse(crypto.randomUUID()),
      kind,
      createdAt,
      origin,
      operationId,
      ...(name ? { name } : {}),
    };
    const commit = await repo.createCommit(
      { tree, parents: tip === null ? [] : [tip], message: formatCommitMessage(metadata), identity, time: createdAt },
      signal,
    );
    // The last point where cancelling changes nothing.
    signal?.throwIfAborted();
    saved = { snapshotId: metadata.snapshotId, kind, createdAt, commit, tree, parent: tip, branch: probe.branch };
  } catch (e) {
    await repo.discardPreparedIndex(operationId).catch(() => undefined);
    throw e;
  }

  // 7. Cleans up after itself, or leaves exactly what recovery needs.
  report('publish', 0, 0, 0, 0);
  await repo.publish({
    operationId,
    ref: probe.headRef,
    expectedOld: tip,
    commit: saved.commit,
    reflogMessage: `draft-tide: ${saved.kind}`,
    ...(options.lockWaitMs !== undefined ? { lockWaitMs: options.lockWaitMs } : {}),
  });
  return {
    ...saved,
    files: capture.files.length,
    bytes: capture.totalBytes,
    newObjects: blobs.length,
    newBytes: capture.newBytes,
    attempts: capture.attempts,
  };
}
