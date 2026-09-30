/**
 * Simulated Engine. In the product these are named operations served by the
 * single local Engine process; here they are pure functions plus timed async
 * "operations" so the GUI can show honest, stage-by-stage progress.
 */
import { pseudoHash, uuid } from '../lib/hash';
import type { DesignOpts } from './designs';
import type {
  EntryOrigin,
  FileChange,
  FileEntry,
  FileSet,
  OperationId,
  OperationStatus,
  PlanId,
  Project,
  RestorePlan,
  SnapshotId,
  SnapshotKind,
  Version,
} from './types';

// ---------------------------------------------------------------------------
// Pure helpers

export function diffFiles(before: FileSet, after: FileSet): FileChange[] {
  const a = new Map(before.map((f) => [f.path, f] as const));
  const b = new Map(after.map((f) => [f.path, f] as const));
  const changes: FileChange[] = [];
  for (const [path, prev] of a) {
    const next = b.get(path);
    if (!next) changes.push({ path, status: 'deleted', before: prev });
    else if (next.hash !== prev.hash) changes.push({ path, status: 'modified', before: prev, after: next });
  }
  for (const [path, next] of b) {
    if (!a.has(path)) changes.push({ path, status: 'added', after: next });
  }
  const order = { modified: 0, added: 1, deleted: 2 } as const;
  return changes.sort((x, y) => order[x.status] - order[y.status] || x.path.localeCompare(y.path));
}

export function fingerprint(files: FileSet): string {
  return pseudoHash(
    files
      .map((f) => `${f.path}\0${f.hash}`)
      .sort()
      .join('\n'),
  );
}

export function latestVersion(p: Project): Version | undefined {
  return p.versions[p.versions.length - 1];
}

export function findVersion(p: Project, id: SnapshotId): Version | undefined {
  return p.versions.find((v) => v.meta.snapshotId === id);
}

export function unsavedChanges(p: Project): FileChange[] {
  const last = latestVersion(p);
  if (!last || !p.sourceAvailable) return [];
  return diffFiles(last.files, p.working);
}

/** Version whose content equals the live folder (if any, newest first). */
export function versionMatchingWorking(p: Project): Version | undefined {
  if (!p.sourceAvailable) return undefined;
  const fp = fingerprint(p.working);
  for (let i = p.versions.length - 1; i >= 0; i--) {
    const v = p.versions[i];
    if (v && fingerprint(v.files) === fp) return v;
  }
  return undefined;
}

export function totalSize(files: FileSet): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}

/** Unique blob bytes across all versions (what the isolated Git history holds). */
export function historyBytes(p: Project): number {
  const seen = new Map<string, number>();
  for (const v of p.versions) for (const f of v.files) seen.set(f.hash, f.size);
  let sum = 0;
  for (const size of seen.values()) sum += size;
  return sum;
}

export function sameScopeFiles(files: FileSet, extra: FileEntry): FileSet {
  return [...files.filter((f) => f.path !== extra.path), extra].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Snapshots

export interface NewVersionInput {
  kind: SnapshotKind;
  origin: EntryOrigin;
  files: FileSet;
  design: DesignOpts;
  name?: string;
  restoreOf?: SnapshotId;
  operationId?: OperationId;
  createdAt?: string;
  snapshotId?: string;
}

export function createVersion(p: Pick<Project, 'versions' | 'scopeHash' | 'entry'>, input: NewVersionInput): Version {
  const snapshotId = (input.snapshotId ?? uuid()) as SnapshotId;
  const meta: Version['meta'] = {
    schemaVersion: 1,
    snapshotId,
    kind: input.kind,
    createdAt: input.createdAt ?? new Date().toISOString(),
    scopeHash: p.scopeHash,
    provider: 'filesystem',
    entryFiles: [p.entry],
    origin: input.origin,
  };
  if (input.name !== undefined && input.name.trim() !== '') meta.name = input.name.trim();
  if (input.restoreOf !== undefined) meta.restoreOf = input.restoreOf;
  if (input.operationId !== undefined) meta.operationId = input.operationId;
  return {
    meta,
    commitOid: pseudoHash(`commit:${snapshotId}`, 40),
    label: `V${p.versions.length + 1}`,
    files: input.files,
    design: input.design,
    previewStatus: 'pending',
  };
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('cancelled', 'AbortError'));
    });
  });

export type CaptureStage = 'reading' | 'verifying' | 'writing';

export type CaptureResult =
  | { ok: true; version: Version }
  | { ok: false; code: 'NO_CHANGES'; same: Version }
  | { ok: false; code: 'LOCAL_ROOT_UNAVAILABLE' };

/** M1 §7.1 in miniature: capture → rescan → build tree → NO_CHANGES or commit. */
export async function captureSnapshot(
  getProject: () => Project,
  input: { name?: string; kind: SnapshotKind; origin: EntryOrigin },
  onStage?: (stage: CaptureStage) => void,
): Promise<CaptureResult> {
  onStage?.('reading');
  await wait(450);
  const p = getProject();
  if (!p.sourceAvailable) return { ok: false, code: 'LOCAL_ROOT_UNAVAILABLE' };
  onStage?.('verifying');
  await wait(350);
  const last = latestVersion(p);
  if (last && fingerprint(last.files) === fingerprint(p.working)) return { ok: false, code: 'NO_CHANGES', same: last };
  onStage?.('writing');
  await wait(300);
  const base: NewVersionInput = { kind: input.kind, origin: input.origin, files: p.working, design: p.workingDesign };
  if (input.name !== undefined) base.name = input.name;
  return { ok: true, version: createVersion(p, base) };
}

// ---------------------------------------------------------------------------
// Restore

export function isTracked(p: Project, path: string): boolean {
  return p.versions.some((v) => v.files.some((f) => f.path === path));
}

export function planRestore(p: Project, targetId: SnapshotId): RestorePlan | null {
  const target = findVersion(p, targetId);
  const head = latestVersion(p);
  if (!target || !head) return null;
  const changes = diffFiles(p.working, target.files);
  const untracked = p.working.filter((f) => {
    if (isTracked(p, f.path)) return false;
    const inTarget = target.files.find((t) => t.path === f.path);
    return !inTarget || inTarget.hash !== f.hash;
  });
  const now = Date.now();
  return {
    planId: uuid() as PlanId,
    projectId: p.id,
    targetId,
    baseHead: head.meta.snapshotId,
    scopeHash: p.scopeHash,
    fingerprint: fingerprint(p.working),
    observed: p.working.map((f) => ({ path: f.path, hash: f.hash })),
    overwrite: changes.filter((c) => c.status === 'modified'),
    add: changes.filter((c) => c.status === 'added'),
    remove: changes.filter((c) => c.status === 'deleted'),
    untracked,
    unsaved: diffFiles(head.files, p.working),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60000).toISOString(),
  };
}

export type RestoreOutcome =
  | {
      ok: true;
      operationId: OperationId;
      protection: Version | null;
      reusedProtection: Version | null;
      restore: Version;
    }
  | { ok: false; code: 'PLAN_STALE'; changed: string[] }
  | { ok: false; code: 'CANCELLED' };

export interface RestoreProgress {
  status: OperationStatus;
  filesDone?: number;
  filesTotal?: number;
  protection?: { created: Version } | { reused: Version };
}

/**
 * Walks the M1 §9.3 state machine with delays. Success is only reported via
 * the final `completed` status; the caller must not show it earlier.
 */
export async function runRestore(
  getProject: () => Project,
  plan: RestorePlan,
  onProgress: (p: RestoreProgress) => void,
  signal: AbortSignal,
): Promise<RestoreOutcome> {
  const operationId = uuid() as OperationId;
  try {
    onProgress({ status: 'confirmed' });
    await wait(500, signal);
    onProgress({ status: 'preflight' });
    await wait(700, signal);

    const p = getProject();
    const current = fingerprint(p.working);
    const head = latestVersion(p);
    if (current !== plan.fingerprint || head?.meta.snapshotId !== plan.baseHead || Date.now() > Date.parse(plan.expiresAt)) {
      const observed = new Map(plan.observed.map((o) => [o.path, o.hash] as const));
      const changed = new Set<string>();
      for (const f of p.working) if (observed.get(f.path) !== f.hash) changed.add(f.path);
      for (const path of observed.keys()) if (!p.working.some((f) => f.path === path)) changed.add(path);
      return { ok: false, code: 'PLAN_STALE', changed: [...changed].sort() };
    }
    const target = findVersion(p, plan.targetId);
    if (!target || !head) return { ok: false, code: 'PLAN_STALE', changed: [] };

    // After this point writes begin; cancellation is no longer offered.
    let protection: Version | null = null;
    let reused: Version | null = null;
    const versionsSoFar = [...p.versions];
    if (plan.unsaved.length > 0) {
      protection = createVersion(
        { versions: versionsSoFar, scopeHash: p.scopeHash, entry: p.entry },
        {
          kind: 'pre-restore',
          origin: 'gui',
          files: p.working,
          design: p.workingDesign,
          name: '回復前保護版本',
          operationId,
        },
      );
      versionsSoFar.push(protection);
    } else {
      reused = head;
    }
    await wait(700);
    onProgress({ status: 'protected', protection: protection ? { created: protection } : { reused: head } });
    await wait(600);
    onProgress({ status: 'staged' });
    await wait(400);

    const total = plan.overwrite.length + plan.add.length + plan.remove.length;
    for (let i = 0; i <= total; i++) {
      onProgress({ status: 'applying', filesDone: i, filesTotal: total });
      if (i < total) await wait(320);
    }
    await wait(300);
    onProgress({ status: 'verified' });
    await wait(600);

    const restore = createVersion(
      { versions: versionsSoFar, scopeHash: p.scopeHash, entry: p.entry },
      {
        kind: 'restore',
        origin: 'gui',
        files: target.files,
        design: target.design,
        name: `回復到 ${target.label}${target.meta.name ? `「${target.meta.name}」` : ''}`,
        restoreOf: target.meta.snapshotId,
        operationId,
      },
    );
    onProgress({ status: 'committed' });
    await wait(400);
    onProgress({ status: 'completed' });
    return { ok: true, operationId, protection, reusedProtection: reused, restore };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, code: 'CANCELLED' };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Backup / import

export type BackupStage = 'collect' | 'bundle' | 'verify' | 'done';

export async function exportBackup(
  p: Project,
  onStage: (s: BackupStage) => void,
): Promise<{ fileName: string; size: number; versionCount: number }> {
  onStage('collect');
  await wait(600);
  onStage('bundle');
  await wait(900);
  onStage('verify');
  await wait(700);
  onStage('done');
  const date = new Date().toISOString().slice(0, 10);
  return {
    fileName: `${p.folderName}-${date}.drafttide`,
    size: Math.round(historyBytes(p) * 0.86 + 24_000),
    versionCount: p.versions.length,
  };
}

export type ImportStage = 'check' | 'history' | 'files' | 'verify' | 'done';

export async function importBackup(
  source: Project,
  destination: { displayPath: string; folderName: string },
  onStage: (s: ImportStage) => void,
): Promise<Project> {
  onStage('check');
  await wait(700);
  onStage('history');
  await wait(700);
  onStage('files');
  await wait(800);
  onStage('verify');
  await wait(600);
  onStage('done');
  const last = latestVersion(source);
  const now = new Date().toISOString();
  return {
    ...source,
    id: uuid() as Project['id'],
    name: `${source.name}（匯入）`,
    folderName: destination.folderName,
    displayPath: destination.displayPath,
    sourceAvailable: true,
    // Snapshot identities are preserved; previews are rebuilt locally.
    versions: source.versions.map((v) => ({ ...v, previewStatus: 'ready' as const })),
    working: last?.files ?? [],
    workingDesign: last?.design ?? source.workingDesign,
    createdAt: now,
    lastOpenedAt: now,
    importedFrom: `${source.folderName}.drafttide`,
  };
}
