import {
  DtError,
  PROJECT_CONFIG_FILE,
  projectConfigError,
  type CaptureProgress,
  type CaptureStage,
  type JsonValue,
  type ProjectConfig,
} from '@draft-tide/contracts';
import { compareGitPaths, mapLimit } from './paths.ts';
import type { FileDigest, GitBlobMode, GitOid, GitRepo, RepoProbe, StagingArea, Workspace } from './ports.ts';
import {
  assertNoBlockers,
  assertSupportedEntries,
  assertUsable,
  attributeVerdict,
  blobMode,
  excludeRules,
  lineEndingBlocker,
  scanScope,
  type ScopeFile,
  type ScopeScan,
} from './scope.ts';

// Optimistic stable capture (M1 plan §7.1 steps 3–5). One attempt:
//
//   1. read `.drafttide.json`, list the scope, check attributes;
//   2. hash every file (read only) and ask Git which blobs it already has;
//   3. check free space for exactly the new content;
//   4. stream only the new content into immutable staging, re-hashing it;
//   5. list and hash everything again: same paths, same ids, same modes.
//
// Any difference means a writer was active: the attempt is discarded and the
// capture retries, at most 3 times, then fails with SOURCE_BUSY. Nothing in
// the folder or its `.git` is written. Git objects for a version later come
// only from the staged bytes, or from blobs the index already references with
// exactly those bytes (same id). This is not a cross-file atomic snapshot: a writer
// that pauses between two related writes can still be captured in between.

export const CAPTURE_MAX_ATTEMPTS = 4;
const DEFAULT_CONCURRENCY = 8;

// Free space that must remain on each volume after the capture and the
// objects it leads to. Headroom, not a quota (TECH_STACK §6.5).
export const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
// Loose objects round up to filesystem blocks; zlib can grow incompressible
// data slightly.
const PER_OBJECT_OVERHEAD = 4096;
const INDEX_ENTRY_BYTES = 72;

export interface CapturedFile {
  path: string;
  mode: GitBlobMode;
  oid: GitOid;
  size: number;
  // Staged copy of the bytes, or null when Git already has this blob.
  staged: string | null;
}

export interface Capture {
  config: ProjectConfig;
  // Everything the version will contain, in Git path order.
  files: CapturedFile[];
  // Tracked paths that are gone and won't be in the version.
  deleted: string[];
  attempts: number;
  totalBytes: number;
  // Bytes staged because Git didn't have them yet.
  newBytes: number;
}

export interface CaptureOptions {
  repo: GitRepo;
  workspace: Workspace;
  staging: StagingArea;
  // A probe taken under the project's write guard; its blockers refuse.
  probe: RepoProbe;
  signal?: AbortSignal;
  onProgress?: (progress: CaptureProgress) => void;
  concurrency?: number;
  // Tests shorten the pause between attempts.
  retryDelayMs?: (attempt: number) => number;
}

interface Hashed {
  file: ScopeFile;
  digest: FileDigest;
  mode: GitBlobMode;
}

type AttemptResult = { stable: true; capture: Capture } | { stable: false; changed: string[] };

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(asError(signal?.reason));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function captureScope(options: CaptureOptions): Promise<Capture> {
  const { probe, staging, signal } = options;
  assertUsable(probe);
  const changed = new Set<string>();
  for (let attempt = 1; attempt <= CAPTURE_MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    await staging.prepareAttempt(attempt);
    let result: AttemptResult;
    try {
      result = await captureAttempt(options, attempt);
    } catch (e) {
      await staging.discardAttempt(attempt);
      throw e;
    }
    if (result.stable) return result.capture;
    for (const p of result.changed) changed.add(p);
    await staging.discardAttempt(attempt);
    if (attempt < CAPTURE_MAX_ATTEMPTS) await sleep(options.retryDelayMs?.(attempt) ?? 100 * attempt, signal);
  }
  const sample = [...changed].sort(compareGitPaths).slice(0, 20);
  throw new DtError(
    'SOURCE_BUSY',
    'files kept changing while saving; stop the tool that is writing to the folder and try again',
    { attempts: CAPTURE_MAX_ATTEMPTS, changed: sample },
  );
}

async function captureAttempt(options: CaptureOptions, attempt: number): Promise<AttemptResult> {
  const { repo, workspace, staging, probe, signal } = options;
  const limit = options.concurrency ?? DEFAULT_CONCURRENCY;
  const progress = progressReporter(options.onProgress, attempt);

  // 1. Scope, with this attempt's own reading of the project's excludes.
  progress.start('scan', 0, 0);
  const configRead = await workspace.readProjectConfig();
  if (!configRead) throw projectConfigError('missing', 'the project settings file is missing');
  const rules = excludeRules(configRead.config);
  const scan = await scanScope(repo, workspace, rules, signal);
  assertNoBlockers(scan.blockers);
  assertSupportedEntries(scan.unsupported);
  const attrs = attributeVerdict(
    await repo.checkAttributes(
      scan.files.map((f) => f.path),
      signal,
    ),
  );
  assertNoBlockers(attrs.blockers);

  // 2. Hash everything.
  const totalBytes = scan.files.reduce((n, f) => n + f.size, 0);
  progress.start('hash', scan.files.length, totalBytes);
  const first = await hashAll(workspace, scan.files, probe.trustExecutableBit, limit, progress, signal);
  if (!first.stable) return { stable: false, changed: first.changed };
  const hashed = first.hashed;
  // The settings that defined the scope are the bytes being saved.
  const configEntry = hashed.find((h) => h.file.path === PROJECT_CONFIG_FILE);
  if (configEntry?.digest.oid !== configRead.oid) return { stable: false, changed: [PROJECT_CONFIG_FILE] };

  const lineEndings = lineEndingBlocker(
    hashed.filter((h) => h.digest.hasCR && attrs.convertingPaths.has(h.file.path)).map((h) => h.file.path),
  );
  if (lineEndings) assertNoBlockers([lineEndings]);

  // 3. Only content Git doesn't have yet needs staging and new objects. A
  // blob counts as present only when the index references it (under any
  // path, so renames and copies are free): gc keeps those, so the version
  // never depends on a dangling object (TECH_STACK §6.5).
  const byOid = new Map<GitOid, Hashed>();
  for (const h of hashed) if (!byOid.has(h.digest.oid)) byOid.set(h.digest.oid, h);
  const existing = await repo.existingBlobs(
    [...byOid.keys()].filter((oid) => scan.indexedBlobs.has(oid)),
    signal,
  );
  const fresh = [...byOid.values()].filter((h) => !existing.has(h.digest.oid));
  const newBytes = fresh.reduce((n, h) => n + h.digest.size, 0);
  await preflight(workspace, staging, {
    newBytes,
    newObjects: fresh.length,
    indexBytes: scan.files.reduce((n, f) => n + INDEX_ENTRY_BYTES + f.path.length * 3, 0),
  });

  // 4. Stage the new content, checking it is still the content just hashed.
  progress.start('stage', fresh.length, newBytes);
  const stagedChanges: string[] = [];
  await mapLimit(
    fresh,
    limit,
    async (h) => {
      const dest = staging.pathFor(attempt, h.digest.oid);
      const r = await workspace.stage(h.file.path, h.file.identity, dest, signal);
      if (r.changed || r.digest.oid !== h.digest.oid) stagedChanges.push(h.file.path);
      progress.advance(h.digest.size);
    },
    signal,
  );
  if (stagedChanges.length > 0) return { stable: false, changed: stagedChanges };

  // 5. Full rescan: the same paths with the same content and modes.
  progress.start('verify', 0, 0);
  const again = await scanScope(repo, workspace, rules, signal);
  // A Git operation that started meanwhile (a merge, say) is reported as such.
  assertNoBlockers(again.blockers);
  const moved = differentPaths(scan, again);
  if (moved.length > 0) return { stable: false, changed: moved };
  progress.start('verify', again.files.length, totalBytes);
  const second = await hashAll(workspace, again.files, probe.trustExecutableBit, limit, progress, signal);
  if (!second.stable) return { stable: false, changed: second.changed };
  const drift = hashed
    .filter((h, i) => {
      const s = second.hashed[i];
      return s?.digest.oid !== h.digest.oid || s.mode !== h.mode;
    })
    .map((h) => h.file.path);
  if (drift.length > 0) return { stable: false, changed: drift };

  return {
    stable: true,
    capture: {
      config: configRead.config,
      files: hashed.map((h) => ({
        path: h.file.path,
        mode: h.mode,
        oid: h.digest.oid,
        size: h.digest.size,
        staged: existing.has(h.digest.oid) ? null : staging.pathFor(attempt, h.digest.oid),
      })),
      deleted: scan.deleted,
      attempts: attempt,
      totalBytes,
      newBytes,
    },
  };
}

async function hashAll(
  workspace: Workspace,
  files: readonly ScopeFile[],
  trustExecutableBit: boolean,
  limit: number,
  progress: ProgressReporter,
  signal?: AbortSignal,
): Promise<{ stable: true; hashed: Hashed[] } | { stable: false; changed: string[] }> {
  const changed: string[] = [];
  const results = await mapLimit(
    files,
    limit,
    async (file) => {
      const r = await workspace.hash(file.path, file.identity, signal);
      progress.advance(file.size);
      if (r.changed) {
        changed.push(file.path);
        return null;
      }
      return { file, digest: r.digest, mode: blobMode(r.digest.executable, file.tracked, trustExecutableBit) };
    },
    signal,
  );
  if (changed.length > 0) return { stable: false, changed };
  return { stable: true, hashed: results as Hashed[] };
}

function differentPaths(a: ScopeScan, b: ScopeScan): string[] {
  const out = new Set<string>();
  const left = new Set(a.files.map((f) => f.path));
  const right = new Set(b.files.map((f) => f.path));
  for (const p of left) if (!right.has(p)) out.add(p);
  for (const p of right) if (!left.has(p)) out.add(p);
  const deletedA = new Set(a.deleted);
  const deletedB = new Set(b.deleted);
  for (const p of deletedA) if (!deletedB.has(p)) out.add(p);
  for (const p of deletedB) if (!deletedA.has(p)) out.add(p);
  // Something unsupported appeared: the next attempt reports it.
  for (const u of b.unsupported) out.add(u.path);
  return [...out];
}

// Free space for exactly what this capture adds: staged copies in the data
// directory and loose objects (plus a new index) in the project's `.git`.
// Checked again by the OS on every write: running out midway is
// INSUFFICIENT_DISK_SPACE too, with the attempt's staging removed.
async function preflight(
  workspace: Workspace,
  staging: StagingArea,
  need: { newBytes: number; newObjects: number; indexBytes: number },
): Promise<void> {
  const [stagingSpace, projectSpace] = await Promise.all([staging.space(), workspace.projectSpace()]);
  const { newBytes, indexBytes: index } = need;
  const objects = newBytes + need.newObjects * PER_OBJECT_OVERHEAD;
  const checks =
    stagingSpace.volume === projectSpace.volume
      ? [{ volume: 'shared', space: stagingSpace, required: newBytes + objects + index + SPACE_MARGIN_BYTES }]
      : [
          { volume: 'app-data', space: stagingSpace, required: newBytes + SPACE_MARGIN_BYTES },
          { volume: 'project', space: projectSpace, required: objects + index + SPACE_MARGIN_BYTES },
        ];
  for (const c of checks) {
    if (c.space.availableBytes < c.required) {
      const details: Record<string, JsonValue> = {
        volume: c.volume,
        requiredBytes: c.required,
        availableBytes: c.space.availableBytes,
      };
      throw new DtError('INSUFFICIENT_DISK_SPACE', 'not enough free disk space to save this version', details);
    }
  }
}

interface ProgressReporter {
  start(stage: CaptureStage, filesTotal: number, bytesTotal: number): void;
  advance(bytes: number): void;
}

function progressReporter(onProgress: ((p: CaptureProgress) => void) | undefined, attempt: number): ProgressReporter {
  let current: CaptureProgress = { stage: 'scan', attempt, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  const emit = () => onProgress?.({ ...current });
  return {
    start(stage, filesTotal, bytesTotal) {
      current = { stage, attempt, filesDone: 0, filesTotal, bytesDone: 0, bytesTotal };
      emit();
    },
    advance(bytes) {
      current.filesDone++;
      current.bytesDone += bytes;
      emit();
    },
  };
}
