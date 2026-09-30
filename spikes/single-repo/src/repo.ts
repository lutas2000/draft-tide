import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, MAX_CONFIG_BYTES, newConfig, parseConfig, serializeConfig, type ProjectConfig } from './config.ts';
import { DtError } from './errors.ts';
import { DEFAULT_IDENTITY, RepoGit, sanitizedEnv, spawnGit, type GitRuntime } from './git.ts';
import { canonicalJson, formatCommitMessage, parseCommitMessage, type Origin, type SnapshotKind, type SnapshotMetadata } from './metadata.ts';
import { probeRepo, type RepoProbe } from './probe.ts';
import {
  attributeVerdict,
  checkAttributes,
  fileHasCR,
  findPathCollisions,
  hashFile,
  mapLimit,
  scanScope,
  stageFile,
  type FileMode,
  type ScopeScan,
} from './scope.ts';

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
const IO_CONCURRENCY = 8;

// Crash injection for the suite: SIGKILL ourselves at a named point.
export function crashPoint(name: string): void {
  if (process.env['SPIKE_CRASH_AT'] === name) process.kill(process.pid, 'SIGKILL');
}

export interface Identity {
  name: string;
  email: string;
}

export interface SaveOptions {
  kind?: 'baseline' | 'manual';
  name?: string;
  origin?: Origin;
  identity?: Identity;
  indexLockWaitMs?: number;
  // Test hooks only.
  beforeUpdateRef?: () => Promise<void> | void;
  skipAttributeChecks?: boolean;
}

export interface SaveResult {
  snapshotId: string;
  commit: string;
  tree: string;
  parent: string | null;
  ref: string;
  stats: { attempts: number; files: number; bytes: number; ms: number };
}

export interface HistoryEntry {
  commit: string;
  tree: string;
  parents: string[];
  author: string;
  meta: SnapshotMetadata | null; // null: made by another tool (engineer, agent)
}

export interface TreeEntry {
  path: string;
  mode: FileMode;
  oid: string;
  size: number;
}

export interface RestorePlan {
  baseTip: string;
  ref: string;
  targetCommit: string;
  targetTree: string;
  writes: { path: string; oid: string; mode: FileMode; expectedLiveOid: string | null }[];
  deletes: { path: string; expectedLiveOid: string }[];
  untracked: string[];
  unsavedChanges: boolean;
  fingerprint: string;
}

type JournalState = 'started' | 'ref-update-intent' | 'committed' | 'completed' | 'abandoned' | 'superseded';
interface Journal {
  operationId: string;
  kind: string;
  state: JournalState;
  ref: string;
  expectedOld: string | null;
  resultingCommit?: string;
  resultingTree?: string;
}

export interface RecoverReport {
  completed: string[];
  abandoned: string[];
  superseded: string[];
}

function assertOid(oid: string): void {
  if (!OID_RE.test(oid)) throw new DtError('GIT_FAILED', 'invalid object id');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DesignRepo {
  readonly rt: GitRuntime;
  readonly dataDir: string;
  readonly root: string;
  readonly git: RepoGit;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rt: GitRuntime, dataDir: string, root: string, opts: { hardened?: boolean } = {}) {
    this.rt = rt;
    this.dataDir = dataDir;
    this.root = root;
    this.git = new RepoGit(rt, root, opts);
  }

  // Adopt a folder as a design project. An existing repo is used as it is
  // (history, branch, remotes untouched); a plain folder gets `git init`.
  // Either way the only working file Draft Tide writes is .drafttide.json.
  static async adopt(rt: GitRuntime, dataDir: string, root: string, opts: { name: string; entryFiles: string[]; projectId?: string }): Promise<DesignRepo> {
    const probe = await probeRepo(rt, root);
    const blocker = probe.blockers[0];
    if (blocker) throw new DtError(blocker.code, `cannot adopt this folder: ${blocker.reason}`, { blockers: probe.blockers });
    if (!probe.gitDir) await spawnGit(rt, ['init', '--quiet', '--initial-branch=main', '--template=', root], root, sanitizedEnv(rt));
    const repo = new DesignRepo(rt, dataDir, root);
    const cfgPath = join(root, CONFIG_FILE);
    try {
      await lstat(cfgPath);
      parseConfig(await readFile(cfgPath)); // already a Draft Tide project (e.g. cloned): keep its identity
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const tmp = `${cfgPath}.dt-tmp-${randomUUID()}`;
      await writeFile(tmp, serializeConfig(newConfig(opts.projectId ?? randomUUID(), opts.name, opts.entryFiles)), { flag: 'wx' });
      await rename(tmp, cfgPath);
    }
    return repo;
  }

  guard<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get projectKey(): string {
    return createHash('sha1').update(this.root).digest('hex').slice(0, 16);
  }

  private get opsDir(): string {
    return join(this.dataDir, 'projects', this.projectKey, 'operations');
  }

  async requireUsable(): Promise<RepoProbe & { headRef: string }> {
    const probe = await probeRepo(this.rt, this.root);
    const b = probe.blockers[0];
    if (b) throw new DtError(b.code, `repository not usable: ${b.reason}`, { blockers: probe.blockers }, b.code === 'REPO_BUSY');
    if (!probe.gitDir || !probe.headRef) throw new DtError('PROJECT_NOT_BOUND', 'folder is not a Draft Tide project yet');
    return probe as RepoProbe & { headRef: string };
  }

  async readWorkingConfig(): Promise<ProjectConfig> {
    const p = join(this.root, CONFIG_FILE);
    let st;
    try {
      st = await lstat(p);
    } catch {
      throw new DtError('PROJECT_NOT_BOUND', `${CONFIG_FILE} is missing`);
    }
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new DtError('CONFIG_INVALID', `${CONFIG_FILE} must be a regular file under ${MAX_CONFIG_BYTES} bytes`);
    return parseConfig(await readFile(p));
  }

  // ---------------------------------------------------------------- reading

  async treeOf(commit: string): Promise<string> {
    assertOid(commit);
    const r = await this.git.run(['cat-file', 'commit', commit]);
    const m = /^tree ([0-9a-f]{40})$/m.exec(r.stdout);
    if (!m?.[1]) throw new DtError('GIT_FAILED', 'commit without tree');
    return m[1];
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
        if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new DtError('UNSUPPORTED_ENTRY', `tree entry ${mode} ${type} cannot be restored`);
        return { path: rec.slice(tab + 1), mode, oid, size: Number(size) };
      });
  }

  async readBlob(oid: string): Promise<Buffer> {
    assertOid(oid);
    return (await this.git.run(['cat-file', 'blob', oid], { maxOutputBytes: 1 << 30 })).stdoutBuffer;
  }

  // The tree the real index currently describes (git write-tree only writes
  // tree objects; it never changes the index).
  async indexTree(): Promise<string> {
    return (await this.git.run(['write-tree'])).stdout.trim();
  }

  async history(): Promise<HistoryEntry[]> {
    const probe = await this.requireUsable();
    if (!probe.tip) return [];
    const r = await this.git.run(['log', '--first-parent', '-z', '--no-color', '--format=%H%x1f%T%x1f%P%x1f%an%x1f%B', '--end-of-options', probe.tip]);
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const [commit = '', tree = '', parents = '', author = '', body = ''] = rec.split('\x1f');
        return { commit, tree, parents: parents ? parents.split(' ') : [], author, meta: parseCommitMessage(body) };
      });
  }

  // --------------------------------------------------------------- capture

  private checkScan(s: ScopeScan): void {
    const b = s.blockers[0];
    if (b) throw new DtError(b.code, `repository not usable: ${b.reason}`, { blockers: s.blockers }, b.code === 'REPO_BUSY');
    if (s.unsupported.length) throw new DtError('UNSUPPORTED_ENTRY', 'the folder contains items that cannot be saved', { entries: s.unsupported.slice(0, 50) });
    const collisions = findPathCollisions(s.files.map((f) => f.path));
    if (collisions.length) throw new DtError('UNSUPPORTED_ENTRY', 'paths differ only by case or Unicode normalization', { collisions: collisions.slice(0, 50) });
  }

  private async capture(cfg: ProjectConfig, opDir: string, opts: SaveOptions) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const s1 = await scanScope(this.git, cfg);
      this.checkScan(s1);
      let convertingPaths: string[] = [];
      if (!opts.skipAttributeChecks) {
        const verdict = attributeVerdict(await checkAttributes(this.git, s1.files.map((f) => f.path)));
        const b = verdict.blockers[0];
        if (b) throw new DtError(b.code, `repository not usable: ${b.reason}`, { blockers: verdict.blockers });
        convertingPaths = verdict.convertingPaths;
      }
      const stageDir = join(opDir, `attempt-${attempt}`);
      await mkdir(stageDir, { mode: 0o700 });
      const staged = await mapLimit(s1.files, IO_CONCURRENCY, (f, i) => stageFile(f, join(stageDir, String(i).padStart(7, '0'))));
      let stable = staged.every((r) => r.stable);
      if (stable) {
        const s2 = await scanScope(this.git, cfg);
        stable = s2.files.length === s1.files.length && s2.files.every((f, i) => f.path === s1.files[i]?.path);
        if (stable) {
          const again = await mapLimit(s2.files, IO_CONCURRENCY, (f) => hashFile(f).catch(() => null));
          stable = again.every((h, i) => h !== null && h.sha256 === staged[i]?.sha256 && h.mode === staged[i]?.mode);
        }
      }
      if (stable) {
        const files = s1.files.map((f, i) => {
          const r = staged[i];
          if (!r) throw new Error('unreachable');
          return { path: f.path, mode: r.mode, size: r.size, gitOid: r.gitOid, stagedPath: join(stageDir, String(i).padStart(7, '0')) };
        });
        // Explicit text/eol attributes make `git status` disagree with raw
        // CRLF bytes; refuse rather than save something Git reads as modified.
        const converting = new Set(convertingPaths);
        const withCR: string[] = [];
        for (const f of files) if (converting.has(f.path) && (await fileHasCR(f.stagedPath))) withCR.push(f.path);
        if (withCR.length) throw new DtError('REPO_UNSUPPORTED', 'line-ending conversion attributes apply to files with CR bytes', { blockers: [{ code: 'REPO_UNSUPPORTED', reason: 'line-ending-normalization', details: { paths: withCR.slice(0, 20) } }] });
        return { files, attempts: attempt, bytes: files.reduce((a, f) => a + f.size, 0) };
      }
      await rm(stageDir, { recursive: true, force: true });
      await sleep(100 * attempt);
    }
    throw new DtError('SOURCE_BUSY', 'files kept changing while saving; stop the tool that is writing and try again', { attempts: 4 }, true);
  }

  // ------------------------------------------------------------------ write

  private async writeJournal(opDir: string, j: Journal): Promise<void> {
    const tmp = join(opDir, `journal.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(j), { mode: 0o600 });
    await rename(tmp, join(opDir, 'journal.json'));
  }

  private async commitTree(tree: string, parent: string | null, meta: SnapshotMetadata, identity: Identity): Promise<string> {
    const epoch = Math.floor(Date.parse(meta.createdAt) / 1000);
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const r = await this.git.run(args, {
      input: formatCommitMessage(meta),
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_DATE: `${epoch} +0000`,
        GIT_COMMITTER_DATE: `${epoch} +0000`,
      },
    });
    return r.stdout.trim();
  }

  private async updateRef(ref: string, next: string, expected: string | null, reason: string): Promise<void> {
    try {
      await this.git.run(['update-ref', '-m', reason, ref, next, expected ?? ZERO_OID]);
    } catch (e) {
      if (e instanceof DtError && /but expected|cannot lock ref|reference already exists|unable to resolve|Unable to create/.test(e.message)) {
        throw new DtError('HISTORY_CHANGED', 'history changed while saving; nothing was overwritten', { expected }, true);
      }
      throw e;
    }
  }

  // ---- index protocol ------------------------------------------------------
  // The real index must describe the new HEAD tree. If it does not, a plain
  // `git commit` by anyone else silently commits the OLD tree on top of the
  // designer's save. So the publish step is:
  //   1. take .git/index.lock (Git's own lock: other Git commands now fail
  //      loudly instead of racing us; we fail with LOCKED *before* anything is
  //      published if someone else holds it),
  //   2. move the ref (compare-and-swap),
  //   3. atomically rename a prebuilt index over .git/index,
  //   4. release the lock.
  // A crash between 2 and 4 leaves our lock behind (loud, not silent); the
  // lock carries the operation id so recovery can tell it is ours.

  private get indexLockPath(): string {
    return join(this.root, '.git', 'index.lock');
  }

  private tmpIndexPath(operationId: string): string {
    // Inside .git so the final rename is on the same volume.
    return join(this.root, '.git', `index.dt-${operationId}`);
  }

  private async acquireIndexLock(operationId: string, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const fh = await open(this.indexLockPath, 'wx', 0o600);
        await fh.writeFile(`draft-tide ${operationId}\n`);
        await fh.close();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (Date.now() >= deadline) throw new DtError('LOCKED', 'another Git command is using this repository right now; nothing was changed, try again', {}, true);
        await sleep(40);
      }
    }
  }

  // Early, cheap refusal for operations that write files before publishing.
  private async assertIndexLockFree(): Promise<void> {
    await this.acquireIndexLock('probe', 0);
    await unlink(this.indexLockPath);
  }

  private async buildIndexFor(tree: string, path: string): Promise<void> {
    assertOid(tree);
    await this.git.run(['read-tree', tree], { env: { GIT_INDEX_FILE: path } });
  }

  private async publish(a: { ref: string; next: string; expected: string | null; tmpIndex: string; operationId: string; reason: string; waitMs?: number }): Promise<void> {
    try {
      await this.acquireIndexLock(a.operationId, a.waitMs ?? 3000);
    } catch (e) {
      await rm(a.tmpIndex, { force: true });
      throw e;
    }
    try {
      await this.updateRef(a.ref, a.next, a.expected, a.reason);
    } catch (e) {
      await unlink(this.indexLockPath).catch(() => undefined);
      await rm(a.tmpIndex, { force: true });
      throw e;
    }
    crashPoint('after-update-ref');
    try {
      await rename(a.tmpIndex, join(this.root, '.git', 'index'));
      crashPoint('after-index-rename');
      await unlink(this.indexLockPath);
    } catch (e) {
      throw new DtError('RECOVERY_REQUIRED', 'the version was saved but the Git index could not be updated; it is repaired automatically on the next operation', { cause: String(e) }, true);
    }
  }

  // Shared by restore and fast-forward: journal the intent, build the index for
  // the target tree, publish.
  private async publishTree(kind: string, operationId: string, a: { ref: string; next: string; expected: string | null; tree: string; reason: string; waitMs?: number | undefined }): Promise<void> {
    const opDir = join(this.opsDir, operationId);
    await mkdir(opDir, { recursive: true, mode: 0o700 });
    const j: Journal = { operationId, kind, state: 'ref-update-intent', ref: a.ref, expectedOld: a.expected, resultingCommit: a.next, resultingTree: a.tree };
    await this.writeJournal(opDir, j);
    const tmpIndex = this.tmpIndexPath(operationId);
    try {
      await this.buildIndexFor(a.tree, tmpIndex);
      await this.publish({ ref: a.ref, next: a.next, expected: a.expected, tmpIndex, operationId, reason: a.reason, ...(a.waitMs !== undefined ? { waitMs: a.waitMs } : {}) });
    } catch (e) {
      if (!(e instanceof DtError && e.code === 'RECOVERY_REQUIRED')) {
        j.state = 'abandoned';
        await this.writeJournal(opDir, j).catch(() => undefined);
        await rm(tmpIndex, { force: true });
      }
      throw e;
    }
    j.state = 'completed';
    await this.writeJournal(opDir, j);
  }

  private async releaseOwnLock(operationId: string): Promise<void> {
    try {
      const holder = await readFile(this.indexLockPath, 'utf8');
      if (holder.startsWith(`draft-tide ${operationId}`)) await unlink(this.indexLockPath);
    } catch {
      /* no lock */
    }
  }

  // Recovery for a publish that died between ref move and index rename.
  private async finishIndex(operationId: string, tree: string): Promise<void> {
    let holder: string | null = null;
    try {
      holder = await readFile(this.indexLockPath, 'utf8');
    } catch {
      /* no lock */
    }
    if (holder !== null) {
      if (!holder.startsWith(`draft-tide ${operationId}`)) throw new DtError('LOCKED', 'another Git command holds the index lock', {}, true);
      await unlink(this.indexLockPath);
    }
    await this.git.run(['read-tree', tree]); // takes the lock itself
    await rm(this.tmpIndexPath(operationId), { force: true });
  }

  private metaFor(kind: SnapshotKind, origin: Origin, extra: { name?: string | undefined; operationId?: string; restoreOf?: string }): SnapshotMetadata {
    const m: SnapshotMetadata = { schemaVersion: 1, snapshotId: randomUUID(), kind, createdAt: new Date().toISOString(), origin };
    if (extra.name) m.name = extra.name;
    if (extra.operationId) m.operationId = extra.operationId;
    if (extra.restoreOf) m.restoreOf = extra.restoreOf;
    return m;
  }

  save(opts: SaveOptions = {}): Promise<SaveResult> {
    return this.guard(() => this.saveLocked(opts));
  }

  private async saveLocked(opts: SaveOptions, kindOverride?: SnapshotKind, operationId = randomUUID()): Promise<SaveResult> {
    const t0 = performance.now();
    const probe = await this.requireUsable();
    const cfg = await this.readWorkingConfig();
    const { headRef: ref, tip } = probe;
    const opDir = join(this.opsDir, operationId);
    await mkdir(opDir, { recursive: true, mode: 0o700 });
    const journal: Journal = { operationId, kind: kindOverride ?? opts.kind ?? 'manual', state: 'started', ref, expectedOld: tip };
    await this.writeJournal(opDir, journal);
    try {
      const cap = await this.capture(cfg, opDir, opts);
      crashPoint('after-capture');
      if (cap.files.length) {
        const r = await this.git.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: cap.files.map((f) => f.stagedPath).join('\n') + '\n' });
        const oids = r.stdout.trim().split('\n');
        if (oids.length !== cap.files.length) throw new DtError('GIT_FAILED', 'hash-object returned wrong number of ids');
        cap.files.forEach((f, i) => {
          if (oids[i] !== f.gitOid) throw new DtError('GIT_FAILED', `object id mismatch for ${f.path}`);
        });
      }
      const index = this.tmpIndexPath(operationId);
      await this.git.run(['update-index', '--add', '-z', '--index-info'], { input: cap.files.map((f) => `${f.mode} ${f.gitOid}\t${f.path}\0`).join(''), env: { GIT_INDEX_FILE: index } });
      const tree = (await this.git.run(['write-tree'], { env: { GIT_INDEX_FILE: index } })).stdout.trim();
      if (tip && (await this.treeOf(tip)) === tree) throw new DtError('NO_CHANGES', 'nothing changed since the last saved version', { tip });

      // "baseline" = the first snapshot Draft Tide makes here: the tip (if any)
      // does not contain the project config yet.
      const adoptedBefore = tip ? (await this.git.run(['ls-tree', '--name-only', tip, '--', CONFIG_FILE])).stdout.trim() !== '' : false;
      const kind: SnapshotKind = kindOverride ?? opts.kind ?? (adoptedBefore ? 'manual' : 'baseline');
      const meta = this.metaFor(kind, opts.origin ?? 'gui', { name: opts.name, operationId });
      const commit = await this.commitTree(tree, tip, meta, opts.identity ?? DEFAULT_IDENTITY);
      journal.state = 'ref-update-intent';
      journal.resultingCommit = commit;
      journal.resultingTree = tree;
      await this.writeJournal(opDir, journal);
      await opts.beforeUpdateRef?.();
      crashPoint('before-update-ref');
      await this.publish({ ref, next: commit, expected: tip, tmpIndex: index, operationId, reason: `draft-tide: ${kind}`, ...(opts.indexLockWaitMs !== undefined ? { waitMs: opts.indexLockWaitMs } : {}) });
      journal.state = 'completed';
      await this.writeJournal(opDir, journal);
      return { snapshotId: meta.snapshotId, commit, tree, parent: tip, ref, stats: { attempts: cap.attempts, files: cap.files.length, bytes: cap.bytes, ms: performance.now() - t0 } };
    } catch (e) {
      const publishedButUnsynced = e instanceof DtError && e.code === 'RECOVERY_REQUIRED';
      if (!publishedButUnsynced && (journal.state === 'started' || journal.state === 'ref-update-intent')) {
        // Nothing was published (or the CAS lost / the lock was busy): the operation is over.
        journal.state = 'abandoned';
        await this.writeJournal(opDir, journal).catch(() => undefined);
      }
      throw e;
    } finally {
      if (journal.state !== 'ref-update-intent') await rm(this.tmpIndexPath(operationId), { force: true });
      for (const d of await readdir(opDir).catch(() => [])) if (d.startsWith('attempt-')) await rm(join(opDir, d), { recursive: true, force: true });
    }
  }

  // Crash / pending-index recovery. Matches by operationId and resultingCommit,
  // never by guessing; only touches the index while HEAD is still our commit.
  recover(): Promise<RecoverReport> {
    return this.guard(async () => {
      const report: RecoverReport = { completed: [], abandoned: [], superseded: [] };
      let ids: string[] = [];
      try {
        ids = await readdir(this.opsDir);
      } catch {
        return report;
      }
      const probe = await this.requireUsable();
      for (const id of ids) {
        const dir = join(this.opsDir, id);
        let j: Journal;
        try {
          j = JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')) as Journal;
        } catch {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        if (j.state === 'completed' || j.state === 'abandoned' || j.state === 'superseded') {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        if (j.state === 'started') {
          j.state = 'abandoned';
          report.abandoned.push(id);
        } else if (j.resultingCommit && j.resultingTree) {
          const tip = probe.tip;
          const reached = tip === j.resultingCommit || (tip !== null && (await this.isAncestor(j.resultingCommit, tip)));
          if (!reached) {
            j.state = 'abandoned'; // the ref never moved
            report.abandoned.push(id);
          } else if (tip === j.resultingCommit) {
            await this.finishIndex(j.operationId, j.resultingTree);
            j.state = 'completed';
            report.completed.push(id);
          } else {
            j.state = 'superseded'; // someone committed on top; their Git owns the index now
            report.superseded.push(id);
          }
        }
        if (j.state === 'abandoned' || j.state === 'superseded') {
          await this.releaseOwnLock(j.operationId);
          await rm(this.tmpIndexPath(j.operationId), { force: true });
        }
        await this.writeJournal(dir, j);
        await rm(dir, { recursive: true, force: true });
      }
      return report;
    });
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    assertOid(a);
    assertOid(b);
    const r = await this.git.run(['merge-base', '--is-ancestor', a, b], { allowExitCodes: [1] });
    return r.exitCode === 0;
  }

  // ---------------------------------------------------------------- restore

  private async liveState(cfg: ProjectConfig): Promise<Map<string, { oid: string; mode: FileMode }>> {
    const s = await scanScope(this.git, cfg);
    this.checkScan(s);
    const digests = await mapLimit(s.files, IO_CONCURRENCY, (f) => hashFile(f));
    return new Map(s.files.map((f, i) => [f.path, { oid: digests[i]?.gitOid ?? '', mode: digests[i]?.mode ?? f.mode }]));
  }

  private fingerprint(tip: string, target: string, live: Map<string, { oid: string; mode: FileMode }>): string {
    const list = [...live.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => [p, v.oid, v.mode]);
    return createHash('sha256').update(canonicalJson({ tip, target, live: list })).digest('hex');
  }

  async planRestore(targetCommit: string): Promise<RestorePlan> {
    const probe = await this.requireUsable();
    if (!probe.tip) throw new DtError('PROJECT_NOT_BOUND', 'no saved versions yet');
    assertOid(targetCommit);
    if (!(await this.isAncestor(targetCommit, probe.tip))) throw new DtError('PLAN_STALE', 'that version is not in this line of history');
    const cfg = await this.readWorkingConfig();
    const [targetTree, headTree, live] = await Promise.all([this.readTree(targetCommit), this.readTree(probe.tip), this.liveState(cfg)]);
    const inTarget = new Map(targetTree.map((e) => [e.path, e]));
    const inHead = new Set(headTree.map((e) => e.path));
    const writes: RestorePlan['writes'] = [];
    const deletes: RestorePlan['deletes'] = [];
    const untracked: string[] = [];
    for (const e of targetTree) {
      const l = live.get(e.path);
      if (!l) writes.push({ path: e.path, oid: e.oid, mode: e.mode, expectedLiveOid: null });
      else if (l.oid !== e.oid || l.mode !== e.mode) {
        if (!inHead.has(e.path)) untracked.push(e.path);
        writes.push({ path: e.path, oid: e.oid, mode: e.mode, expectedLiveOid: l.oid });
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
      baseTip: probe.tip,
      ref: probe.headRef,
      targetCommit,
      targetTree: await this.treeOf(targetCommit),
      writes,
      deletes,
      untracked: untracked.sort(),
      unsavedChanges,
      fingerprint: this.fingerprint(probe.tip, targetCommit, live),
    };
  }

  // Appends history: [pre-restore protection] -> restore commit whose tree is
  // the target tree. HEAD never moves backwards.
  applyRestore(plan: RestorePlan, origin: Origin = 'gui', opts: { indexLockWaitMs?: number } = {}): Promise<{ protection: SaveResult | null; restoreCommit: string }> {
    return this.guard(async () => {
      const probe = await this.requireUsable();
      if (probe.tip !== plan.baseTip || probe.headRef !== plan.ref) throw new DtError('PLAN_STALE', 'history changed since the plan was made');
      if (plan.untracked.length) throw new DtError('UNTRACKED_FILES', 'unsaved new files would be overwritten or deleted', { paths: plan.untracked.slice(0, 50) });
      const cfg = await this.readWorkingConfig();
      const live = await this.liveState(cfg);
      if (this.fingerprint(plan.baseTip, plan.targetCommit, live) !== plan.fingerprint) throw new DtError('PLAN_STALE', 'files changed since the plan was made; check the restore again');

      await this.assertIndexLockFree();
      const operationId = randomUUID();
      let parent = plan.baseTip;
      let protection: SaveResult | null = null;
      if (plan.unsavedChanges) {
        protection = await this.saveLocked({ origin }, 'pre-restore', operationId);
        parent = protection.commit;
      }
      await this.applyFiles(plan.writes, plan.deletes);
      const targetEntries = await this.readTree(plan.targetCommit);
      const after = await this.liveState(cfg);
      // The restored config may differ from the one used for planning; verify
      // against the target tree itself.
      const matches = after.size === targetEntries.length && targetEntries.every((e) => after.get(e.path)?.oid === e.oid && after.get(e.path)?.mode === e.mode);
      if (!matches) throw new DtError('RECOVERY_REQUIRED', 'restored files did not verify; nothing further was written', { operationId });

      const meta = this.metaFor('restore', origin, { operationId });
      const restoreCommit = await this.commitTree(plan.targetTree, parent, meta, DEFAULT_IDENTITY);
      await this.publishTree('restore', randomUUID(), { ref: plan.ref, next: restoreCommit, expected: parent, tree: plan.targetTree, reason: 'draft-tide: restore', waitMs: opts.indexLockWaitMs });
      return { protection, restoreCommit };
    });
  }

  // Writes planned files with tmp + rename, checking each live file still has
  // the expected content right before replacing it.
  async applyFiles(writes: RestorePlan['writes'], deletes: RestorePlan['deletes']): Promise<void> {
    let done = 0;
    for (const w of writes) {
      const abs = await this.safeTarget(w.path);
      const tmp = join(dirname(abs), `.${w.path.split('/').pop()}.dt-tmp-${randomUUID()}`);
      const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: true });
      await new Promise<void>((res, rej) => {
        out.once('error', rej);
        out.once('close', () => res());
        this.readBlob(w.oid).then((b) => out.end(b), rej);
      });
      await chmod(tmp, w.mode === '100755' ? 0o755 : 0o644);
      await this.expectLive(abs, w.expectedLiveOid, done, tmp);
      await rename(tmp, abs);
      done++;
    }
    for (const d of deletes) {
      const abs = await this.safeTarget(d.path);
      await this.expectLive(abs, d.expectedLiveOid, done, null);
      await unlink(abs);
      done++;
    }
  }

  private async expectLive(abs: string, expectedOid: string | null, alreadyWritten: number, tmp: string | null): Promise<void> {
    let current: string | null = null;
    try {
      const st = await lstat(abs, { bigint: true });
      if (!st.isFile()) throw new DtError('UNSUPPORTED_ENTRY', 'a target is not a regular file');
      current = (await hashFile({ abs, ino: st.ino, dev: st.dev })).gitOid;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current !== expectedOid) {
      if (tmp) await rm(tmp, { force: true });
      throw new DtError(alreadyWritten === 0 ? 'PLAN_STALE' : 'RECOVERY_REQUIRED', 'a file changed while writing; stopped without overwriting it', { alreadyWritten });
    }
  }

  private async safeTarget(rel: string): Promise<string> {
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new DtError('PATH_OUTSIDE_ROOT', 'invalid path in snapshot');
    let cur = this.root;
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

  // ------------------------------------------------- fast-forward / clone

  // Moves the current branch forward to a descendant commit and brings the
  // working files with it. Refuses unsaved work and anything not a pure
  // fast-forward. Used by pull and by opening a project from a remote.
  fastForward(target: string, opts: { indexLockWaitMs?: number } = {}): Promise<{ from: string | null; to: string; filesWritten: number; filesDeleted: number }> {
    return this.guard(async () => {
      assertOid(target);
      const probe = await this.requireUsable();
      const tip = probe.tip;
      if (tip && !(await this.isAncestor(tip, target))) throw new DtError('REMOTE_DIVERGED', 'this is not a fast-forward of the current version', { tip, target });
      const targetEntries = await this.readTree(target);
      const tipEntries = tip ? await this.readTree(tip) : [];
      const tipMap = new Map(tipEntries.map((e) => [e.path, e]));
      const toMap = new Map(targetEntries.map((e) => [e.path, e]));
      let live: Map<string, { oid: string; mode: FileMode }>;
      if (tip) {
        const cfg = await this.readWorkingConfig();
        live = await this.liveState(cfg);
        const dirty = live.size !== tipEntries.length || [...live].some(([p, l]) => tipMap.get(p)?.oid !== l.oid || tipMap.get(p)?.mode !== l.mode);
        if (dirty) throw new DtError('UNSAVED_CHANGES', 'there are unsaved changes; save a version first');
      } else {
        live = new Map();
        const entries = (await readdir(this.root)).filter((n) => n !== '.git');
        if (entries.length) throw new DtError('UNTRACKED_FILES', 'the folder is not empty', { sample: entries.slice(0, 5) });
      }
      const writes: RestorePlan['writes'] = [];
      const deletes: RestorePlan['deletes'] = [];
      for (const e of targetEntries) {
        const cur = tipMap.get(e.path);
        if (!cur || cur.oid !== e.oid || cur.mode !== e.mode) writes.push({ path: e.path, oid: e.oid, mode: e.mode, expectedLiveOid: live.get(e.path)?.oid ?? null });
      }
      for (const e of tipEntries) if (!toMap.has(e.path)) deletes.push({ path: e.path, expectedLiveOid: live.get(e.path)?.oid ?? e.oid });
      await this.assertIndexLockFree();
      await this.applyFiles(writes, deletes);
      const targetTree = await this.treeOf(target);
      await this.publishTree('fast-forward', randomUUID(), { ref: probe.headRef, next: target, expected: tip, tree: targetTree, reason: 'draft-tide: fast-forward', waitMs: opts.indexLockWaitMs });
      return { from: tip, to: target, filesWritten: writes.length, filesDeleted: deletes.length };
    });
  }
}

export async function unlinkQuiet(p: string): Promise<void> {
  await unlink(p).catch(() => undefined);
}
