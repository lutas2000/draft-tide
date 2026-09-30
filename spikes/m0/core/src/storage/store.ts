import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { DtError } from '../shared/errors.ts';
import { BlobReader, Git, type GitRuntime } from '../shared/git.ts';
import {
  canonicalJson,
  formatCommitMessage,
  parseCommitMessage,
  type Origin,
  type SnapshotKind,
  type SnapshotMetadata,
} from './metadata.ts';
import {
  DEFAULT_SCOPE_POLICY,
  findPathCollisions,
  hashFile,
  mapLimit,
  scan,
  scopeHash,
  stageFile,
  type FileMode,
  type ScanResult,
  type ScopePolicy,
} from './scope.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const MAIN = 'refs/heads/main';
const OID_RE = /^[0-9a-f]{40}$/;
const IO_CONCURRENCY = 8;
const SPACE_MARGIN = 64 * 1024 * 1024;
// 'strict': fsync every staged file and hash every staged file into Git.
// 'fast': no staging fsync, only content Git does not already have is hashed
// in. Both publish the ref only after the new Git objects are fsynced.
export const CAPTURE_MODE: 'strict' | 'fast' = process.env['M0_CAPTURE_MODE'] === 'strict' ? 'strict' : 'fast';

export interface ProjectConfig {
  projectId: string;
  root: string;
  entryFiles: string[];
  policy: ScopePolicy;
}

export interface CapturedFile {
  path: string;
  mode: FileMode;
  size: number;
  sha256: string;
  gitOid: string;
  stagedPath: string;
}

export interface CaptureStats {
  attempts: number;
  files: number;
  bytes: number;
  scanMs: number;
  stageMs: number;
  rescanMs: number;
}

export interface SnapshotInfo {
  commit: string;
  tree: string;
  parents: string[];
  meta: SnapshotMetadata;
}

export interface TreeEntry {
  path: string;
  mode: FileMode;
  oid: string;
  size: number;
}

export interface SnapshotResult {
  snapshotId: string;
  commit: string;
  tree: string;
  kind: SnapshotKind;
  capture: CaptureStats;
  writeObjectsMs: number;
  newBlobs: number;
}

export interface RestorePlan {
  planId: string;
  projectId: string;
  baseHead: string;
  targetCommit: string;
  targetTree: string;
  targetSnapshotId: string;
  scopeHash: string;
  writes: { path: string; action: 'add' | 'overwrite'; oid: string; mode: FileMode; expectedLiveOid: string | null }[];
  deletes: { path: string; expectedLiveOid: string }[];
  untracked: string[];
  unsavedChanges: boolean;
  fingerprint: string;
  expiresAt: string;
  requiredBytes: number;
}

export class ProjectStore {
  readonly git: Git;
  readonly cfg: ProjectConfig;
  readonly projectDir: string;
  readonly repoDir: string;
  readonly scopeHash: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(dataDir: string, rt: GitRuntime, cfg: ProjectConfig) {
    this.cfg = cfg;
    this.projectDir = join(dataDir, 'projects', cfg.projectId);
    this.repoDir = join(this.projectDir, 'repo.git');
    this.git = new Git(rt, this.repoDir);
    this.scopeHash = scopeHash(cfg.policy, cfg.entryFiles);
  }

  static async create(dataDir: string, rt: GitRuntime, opts: { root: string; entryFiles: string[]; policy?: ScopePolicy; projectId?: string }): Promise<ProjectStore> {
    const store = new ProjectStore(dataDir, rt, {
      projectId: opts.projectId ?? randomUUID(),
      root: opts.root,
      entryFiles: opts.entryFiles,
      policy: opts.policy ?? DEFAULT_SCOPE_POLICY,
    });
    await mkdir(store.projectDir, { recursive: true, mode: 0o700 });
    await store.git.run(['init', '--quiet', '--bare', '--initial-branch=main', '--template=', store.repoDir]);
    // Persisted too, so any Git process that misses the -c flags still never
    // auto-GCs or runs maintenance on history the Engine manages.
    for (const [k, v] of [
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['core.logAllRefUpdates', 'always'],
      ['receive.denyNonFastForwards', 'true'],
    ] as const) {
      await store.git.run(['config', '--local', k, v]);
    }
    return store;
  }

  static open(dataDir: string, rt: GitRuntime, cfg: ProjectConfig): ProjectStore {
    return new ProjectStore(dataDir, rt, cfg);
  }

  // Project write guard: serializes every write on this project.
  guard<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async head(): Promise<string | null> {
    const r = await this.git.run(['for-each-ref', '--format=%(objectname)', MAIN]);
    const oid = r.stdout.trim();
    return oid ? oid : null;
  }

  async treeOf(commit: string): Promise<string> {
    assertOid(commit);
    const r = await this.git.run(['cat-file', 'commit', commit]);
    const m = /^tree ([0-9a-f]{40})$/m.exec(r.stdout);
    if (!m?.[1]) throw new DtError('GIT_FAILED', 'commit without tree');
    return m[1];
  }

  private async preflightSpace(bytes: number): Promise<void> {
    const s = await statfs(this.projectDir);
    const available = s.bavail * s.bsize;
    // staging copy + worst-case new loose objects + margin; never a quota.
    const required = bytes * 2 + SPACE_MARGIN;
    if (available < required) {
      throw new DtError('INSUFFICIENT_DISK_SPACE', 'not enough free space to save this version', { requiredBytes: required, availableBytes: available, volume: 'history' }, true);
    }
  }

  async scanScope(): Promise<ScanResult> {
    try {
      return await scan(this.cfg.root, this.cfg.policy);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'design folder is not available');
      throw e;
    }
  }

  private checkScan(s: ScanResult): void {
    if (s.unsupported.length) {
      throw new DtError('UNSUPPORTED_ENTRY', 'the folder contains items that cannot be saved; exclude them first', { entries: s.unsupported.slice(0, 50) });
    }
    const collisions = findPathCollisions(s.files.map((f) => f.path));
    if (collisions.length) throw new DtError('UNSUPPORTED_ENTRY', 'paths differ only by case or Unicode normalization', { collisions: collisions.slice(0, 50) });
  }

  // M1 plan §7.1 steps 3–5: stream into immutable staging, full rescan of
  // path set + hashes, up to three retries, then SOURCE_BUSY.
  async capture(operationId: string): Promise<{ files: CapturedFile[]; opDir: string; stats: CaptureStats }> {
    const opDir = join(this.projectDir, 'operations', operationId);
    await mkdir(opDir, { recursive: true, mode: 0o700 });
    for (let attempt = 1; attempt <= 4; attempt++) {
      let t = performance.now();
      const s1 = await this.scanScope();
      this.checkScan(s1);
      const scanMs = performance.now() - t;
      const totalBytes = s1.files.reduce((a, f) => a + f.size, 0);
      await this.preflightSpace(totalBytes);

      const stageDir = join(opDir, `attempt-${attempt}`);
      await mkdir(stageDir, { mode: 0o700 });
      t = performance.now();
      const staged = await mapLimit(s1.files, IO_CONCURRENCY, (f, i) => stageFile(f, join(stageDir, String(i).padStart(7, '0')), CAPTURE_MODE === 'strict'));
      const stageMs = performance.now() - t;

      t = performance.now();
      let stable = staged.every((r) => r.stable);
      if (stable) {
        const s2 = await this.scanScope();
        stable = s2.files.length === s1.files.length && s2.files.every((f, i) => f.path === s1.files[i]?.path);
        if (stable) {
          const again = await mapLimit(s2.files, IO_CONCURRENCY, (f) => hashFile(f).catch(() => null));
          stable = again.every((h, i) => h !== null && h.sha256 === staged[i]?.sha256 && h.mode === staged[i]?.mode);
        }
      }
      const rescanMs = performance.now() - t;
      if (stable) {
        const files = s1.files.map((f, i): CapturedFile => {
          const r = staged[i];
          if (!r) throw new Error('unreachable');
          return { path: f.path, mode: r.mode, size: r.size, sha256: r.sha256, gitOid: r.gitOid, stagedPath: join(stageDir, String(i).padStart(7, '0')) };
        });
        return { files, opDir, stats: { attempts: attempt, files: files.length, bytes: totalBytes, scanMs, stageMs, rescanMs } };
      }
      await rm(stageDir, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
    await rm(opDir, { recursive: true, force: true });
    throw new DtError('SOURCE_BUSY', 'files kept changing while saving; stop the tool that is writing and try again', { attempts: 4 }, true);
  }

  // Objects come only from staged bytes. The OID Git reports must equal the
  // blob OID we computed while streaming, which proves no filter touched it.
  private async writeTree(files: CapturedFile[], opDir: string): Promise<{ tree: string; newBlobs: number }> {
    let toWrite = files;
    if (CAPTURE_MODE === 'fast' && files.length) {
      const r = await this.git.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: files.map((f) => f.gitOid).join('\n') + '\n' });
      const have = new Set(r.stdout.split('\n').filter((l) => l.endsWith(' blob')).map((l) => l.slice(0, 40)));
      const seen = new Set<string>();
      toWrite = files.filter((f) => !have.has(f.gitOid) && !seen.has(f.gitOid) && seen.add(f.gitOid));
    }
    if (toWrite.length) {
      // core.fsyncMethod=batch was measured slower on APFS (4.1 s vs ~1 s for
      // 930 new objects), so objects keep the default per-object fsync.
      const r = await this.git.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: toWrite.map((f) => f.stagedPath).join('\n') + '\n' });
      const oids = r.stdout.trim().split('\n');
      if (oids.length !== toWrite.length) throw new DtError('GIT_FAILED', 'hash-object returned wrong number of ids');
      toWrite.forEach((f, i) => {
        if (oids[i] !== f.gitOid) throw new DtError('GIT_FAILED', `object id mismatch for ${f.path}`);
      });
    }
    const index = join(opDir, 'index');
    await this.git.run(['update-index', '--add', '-z', '--index-info'], {
      input: files.map((f) => `${f.mode} ${f.gitOid}\t${f.path}\0`).join(''),
      env: { GIT_INDEX_FILE: index },
    });
    const tree = (await this.git.run(['write-tree'], { env: { GIT_INDEX_FILE: index } })).stdout.trim();
    return { tree, newBlobs: toWrite.length };
  }

  private async commit(tree: string, parent: string | null, meta: SnapshotMetadata): Promise<string> {
    const epoch = Math.floor(Date.parse(meta.createdAt) / 1000);
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const r = await this.git.run(args, {
      input: formatCommitMessage(meta),
      env: { GIT_AUTHOR_DATE: `${epoch} +0000`, GIT_COMMITTER_DATE: `${epoch} +0000` },
    });
    return r.stdout.trim();
  }

  private async updateMain(next: string, expected: string | null, reason: string): Promise<void> {
    try {
      await this.git.run(['update-ref', '-m', reason, MAIN, next, expected ?? ZERO_OID]);
    } catch (e) {
      if (e instanceof DtError && /but expected|reference already exists|unable to resolve/.test(e.message)) {
        throw new DtError('HISTORY_CHANGED', 'history changed while saving; nothing was overwritten', { expected }, true);
      }
      throw e;
    }
  }

  private meta(kind: SnapshotKind, origin: Origin, extra: { name?: string | undefined; operationId?: string; restoreOf?: string }): SnapshotMetadata {
    const m: SnapshotMetadata = {
      schemaVersion: 1,
      snapshotId: randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
      scopeHash: this.scopeHash,
      provider: 'filesystem',
      entryFiles: this.cfg.entryFiles,
      origin,
    };
    if (extra.name) m.name = extra.name;
    if (extra.operationId) m.operationId = extra.operationId;
    if (extra.restoreOf) m.restoreOf = extra.restoreOf;
    return m;
  }

  snapshot(opts: { kind: SnapshotKind; origin: Origin; name?: string }): Promise<SnapshotResult> {
    return this.guard(() => this.snapshotLocked(opts));
  }

  private async snapshotLocked(opts: { kind: SnapshotKind; origin: Origin; name?: string | undefined; operationId?: string }): Promise<SnapshotResult> {
    const operationId = opts.operationId ?? randomUUID();
    const head = await this.head();
    const cap = await this.capture(randomUUID());
    try {
      const t = performance.now();
      const { tree, newBlobs } = await this.writeTree(cap.files, cap.opDir);
      const writeObjectsMs = performance.now() - t;
      if (head && (await this.treeOf(head)) === tree) {
        throw new DtError('NO_CHANGES', 'nothing changed since the last saved version', { head });
      }
      const extra: { name?: string | undefined; operationId?: string } = { name: opts.name };
      if (opts.kind === 'pre-restore') extra.operationId = operationId;
      const meta = this.meta(opts.kind, opts.origin, extra);
      const commit = await this.commit(tree, head, meta);
      await this.updateMain(commit, head, `draft-tide: ${opts.kind}`);
      return { snapshotId: meta.snapshotId, commit, tree, kind: opts.kind, capture: cap.stats, writeObjectsMs, newBlobs };
    } finally {
      // Safe end of the operation: staging is no longer referenced.
      await rm(cap.opDir, { recursive: true, force: true });
    }
  }

  async history(): Promise<SnapshotInfo[]> {
    const head = await this.head();
    if (!head) return [];
    const r = await this.git.run(['log', '--first-parent', '-z', '--no-color', '--format=%H%x1f%T%x1f%P%x1f%B', '--end-of-options', head]);
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const [commit = '', tree = '', parents = '', body = ''] = rec.split('\x1f');
        const meta = parseCommitMessage(body);
        if (!meta) throw new DtError('GIT_FAILED', `commit ${commit} has no valid Draft Tide metadata`);
        return { commit, tree, parents: parents ? parents.split(' ') : [], meta };
      });
  }

  async findSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    const found = (await this.history()).find((s) => s.meta.snapshotId === snapshotId);
    if (!found) throw new DtError('PLAN_STALE', 'version not found in this project', { snapshotId });
    return found;
  }

  async readTree(commit: string): Promise<TreeEntry[]> {
    assertOid(commit);
    const r = await this.git.run(['ls-tree', '-r', '-z', '--full-tree', '-l', '--end-of-options', commit]);
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const tab = rec.indexOf('\t');
        const [mode = '', type = '', oid = '', size = ''] = rec.slice(0, tab).split(/ +/);
        if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new DtError('GIT_FAILED', `unexpected tree entry ${mode} ${type}`);
        return { path: rec.slice(tab + 1), mode, oid, size: Number(size) };
      });
  }

  // Streams every blob of a snapshot and returns sha256 per path.
  async digestSnapshot(commit: string): Promise<Map<string, { sha256: string; mode: FileMode; oid: string }>> {
    const entries = await this.readTree(commit);
    const reader = new BlobReader(this.git);
    const out = new Map<string, { sha256: string; mode: FileMode; oid: string }>();
    try {
      for (const e of entries) {
        const h = createHash('sha256');
        await reader.read(e.oid, new Writable({ write: (c: Buffer, _e, cb) => (h.update(c), cb()) }));
        out.set(e.path, { sha256: h.digest('hex'), mode: e.mode, oid: e.oid });
      }
    } finally {
      reader.close();
    }
    return out;
  }

  private async liveState(): Promise<Map<string, { oid: string; mode: FileMode }>> {
    const s = await this.scanScope();
    this.checkScan(s);
    const digests = await mapLimit(s.files, IO_CONCURRENCY, (f) => hashFile(f));
    return new Map(s.files.map((f, i) => [f.path, { oid: digests[i]?.gitOid ?? '', mode: digests[i]?.mode ?? f.mode }]));
  }

  private fingerprint(head: string, target: string, live: Map<string, { oid: string; mode: FileMode }>): string {
    const liveList = [...live.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => [p, v.oid, v.mode]);
    return createHash('sha256').update(canonicalJson({ head, target, scopeHash: this.scopeHash, live: liveList })).digest('hex');
  }

  // M1 plan §9.2. Read-only: nothing is written.
  async planRestore(targetSnapshotId: string, ttlMs = 10 * 60_000): Promise<RestorePlan> {
    const head = await this.head();
    if (!head) throw new DtError('PROJECT_NOT_BOUND', 'no saved versions yet');
    const target = await this.findSnapshot(targetSnapshotId);
    if (target.meta.scopeHash !== this.scopeHash) throw new DtError('SCOPE_CHANGED', 'that version was saved with a different scope');
    const [targetTree, headTree, live] = await Promise.all([this.readTree(target.commit), this.readTree(head), this.liveState()]);
    const inTarget = new Map(targetTree.map((e) => [e.path, e]));
    const inHead = new Set(headTree.map((e) => e.path));
    const writes: RestorePlan['writes'] = [];
    const deletes: RestorePlan['deletes'] = [];
    const untracked: string[] = [];
    for (const e of targetTree) {
      const l = live.get(e.path);
      if (!l) writes.push({ path: e.path, action: 'add', oid: e.oid, mode: e.mode, expectedLiveOid: null });
      else if (l.oid !== e.oid || l.mode !== e.mode) {
        if (!inHead.has(e.path)) untracked.push(e.path);
        writes.push({ path: e.path, action: 'overwrite', oid: e.oid, mode: e.mode, expectedLiveOid: l.oid });
      }
    }
    for (const [path, l] of live) {
      if (inTarget.has(path)) continue;
      if (!inHead.has(path)) untracked.push(path);
      deletes.push({ path, expectedLiveOid: l.oid });
    }
    const headMap = new Map(headTree.map((e) => [e.path, e]));
    const unsavedChanges = live.size !== headTree.length || [...live].some(([p, l]) => headMap.get(p)?.oid !== l.oid || headMap.get(p)?.mode !== l.mode);
    return {
      planId: randomUUID(),
      projectId: this.cfg.projectId,
      baseHead: head,
      targetCommit: target.commit,
      targetTree: target.tree,
      targetSnapshotId,
      scopeHash: this.scopeHash,
      writes,
      deletes,
      untracked: untracked.sort(),
      unsavedChanges,
      fingerprint: this.fingerprint(head, target.commit, live),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      requiredBytes: writes.reduce((a, w) => a + (inTarget.get(w.path)?.size ?? 0), 0),
    };
  }

  // M1 plan §9.3 without the SQLite journal (M1-05). Appends history:
  // [pre-restore protection] → restore commit whose tree is the target tree.
  applyRestore(plan: RestorePlan, origin: Origin): Promise<{ protection: SnapshotResult | null; restoreCommit: string; restoreSnapshotId: string }> {
    return this.guard(async () => {
      if (Date.now() > Date.parse(plan.expiresAt)) throw new DtError('PLAN_STALE', 'the restore plan expired; check it again');
      const head = await this.head();
      if (head !== plan.baseHead) throw new DtError('PLAN_STALE', 'history changed since the plan was made');
      if (plan.untracked.length) throw new DtError('UNTRACKED_FILES', 'unsaved new files would be overwritten or deleted', { paths: plan.untracked.slice(0, 50) });
      const live = await this.liveState();
      if (this.fingerprint(head, plan.targetCommit, live) !== plan.fingerprint) throw new DtError('PLAN_STALE', 'files changed since the plan was made; check the restore again');
      await this.preflightSpace(plan.requiredBytes);

      const operationId = randomUUID();
      let parent: string = head;
      let protection: SnapshotResult | null = null;
      if (plan.unsavedChanges) {
        protection = await this.snapshotLocked({ kind: 'pre-restore', origin, operationId });
        parent = protection.commit;
      }

      const reader = new BlobReader(this.git);
      let written = 0;
      try {
        for (const w of plan.writes) {
          const abs = await this.safeTarget(w.path);
          const tmp = join(dirname(abs), `.${w.path.split('/').pop()}.dt-tmp-${randomUUID()}`);
          const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: true });
          await reader.read(w.oid, out);
          await endAndClose(out);
          await chmod(tmp, w.mode === '100755' ? 0o755 : 0o644);
          await this.expectLive(abs, w.expectedLiveOid, written, tmp);
          await rename(tmp, abs);
          written++;
        }
        for (const d of plan.deletes) {
          const abs = await this.safeTarget(d.path);
          await this.expectLive(abs, d.expectedLiveOid, written, null);
          await unlink(abs);
          written++;
        }
      } finally {
        reader.close();
      }

      const after = await this.liveState();
      const targetTree = await this.readTree(plan.targetCommit);
      const matches = after.size === targetTree.length && targetTree.every((e) => after.get(e.path)?.oid === e.oid && after.get(e.path)?.mode === e.mode);
      if (!matches) throw new DtError('RECOVERY_REQUIRED', 'restored files did not verify; nothing further was written', { operationId });

      const meta = this.meta('restore', origin, { operationId, restoreOf: plan.targetSnapshotId });
      const restoreCommit = await this.commit(plan.targetTree, parent, meta);
      await this.updateMain(restoreCommit, parent, 'draft-tide: restore');
      return { protection, restoreCommit, restoreSnapshotId: meta.snapshotId };
    });
  }

  private async expectLive(abs: string, expectedOid: string | null, alreadyWritten: number, tmp: string | null): Promise<void> {
    let current: string | null = null;
    try {
      const st = await lstat(abs, { bigint: true });
      if (!st.isFile()) throw new DtError('UNSUPPORTED_ENTRY', 'a restore target is not a regular file');
      current = (await hashFile({ abs, ino: st.ino, dev: st.dev })).gitOid;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current !== expectedOid) {
      if (tmp) await rm(tmp, { force: true });
      throw new DtError(alreadyWritten === 0 ? 'PLAN_STALE' : 'RECOVERY_REQUIRED', 'a file changed during restore; stopped without overwriting it', { alreadyWritten });
    }
  }

  // Resolves a tree path inside root, creating parents, refusing symlinked or
  // non-directory components.
  private async safeTarget(rel: string): Promise<string> {
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new DtError('PATH_OUTSIDE_ROOT', 'invalid path in snapshot');
    let cur = this.cfg.root;
    for (const p of parts.slice(0, -1)) {
      cur = join(cur, p);
      try {
        const st = await lstat(cur);
        if (!st.isDirectory()) throw new DtError('PATH_OUTSIDE_ROOT', 'a parent folder is a link or file');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        await mkdir(cur);
      }
    }
    return join(cur, parts[parts.length - 1] as string);
  }

  // Writes a snapshot into an empty folder (used by backup import).
  async materialize(commit: string, dest: string): Promise<number> {
    await mkdir(dest, { recursive: true });
    if ((await readdir(dest)).length) throw new DtError('UNTRACKED_FILES', 'destination folder is not empty');
    const entries = await this.readTree(commit);
    const reader = new BlobReader(this.git);
    try {
      for (const e of entries) {
        const abs = join(dest, ...e.path.split('/'));
        await mkdir(dirname(abs), { recursive: true });
        const out = createWriteStream(abs, { flags: 'wx', mode: e.mode === '100755' ? 0o755 : 0o644, flush: true });
        await reader.read(e.oid, out);
        await endAndClose(out);
      }
    } finally {
      reader.close();
    }
    return entries.length;
  }

  async fsck(): Promise<string> {
    const r = await this.git.run(['fsck', '--full', '--strict', '--no-dangling', '--no-progress']);
    return (r.stdout + r.stderr).trim();
  }
}

function assertOid(oid: string): void {
  if (!OID_RE.test(oid)) throw new DtError('GIT_FAILED', 'invalid object id');
}

// Resolves after the fd is fsynced (flush: true) and closed, so a following
// rename never publishes a file whose bytes are not yet durable.
function endAndClose(out: WriteStream): Promise<void> {
  return new Promise((res, rej) => {
    out.once('error', rej);
    out.once('close', () => res());
    out.end();
  });
}
