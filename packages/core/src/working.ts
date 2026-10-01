import type { RepoBlocker, StatusChange, UnsupportedEntry } from '@draft-tide/contracts';
import { diffTreeFiles, type TreeFileAt } from './compare.ts';
import { compareGitPaths, mapLimit } from './paths.ts';
import type { FileDigest, FileIdentity, GitRepo, GitTreeEntry, RepoProbe, Workspace } from './ports.ts';
import { attributeVerdict, blobMode, excludeRules, lineEndingBlocker, scanScope, type ScopeFile } from './scope.ts';
import type { ProjectConfig } from '@draft-tide/contracts';

// The folder compared with the newest commit, for display (M1 plan §3 查看狀態):
// what the next save would record. Saving never relies on this; it hashes
// every file again (M1 plan §7.1).

// Digests of files that did not change since they were hashed, keyed by path
// and the file's full identity. A file modified within RACY_MS of being hashed
// is not remembered: a second write in the same timestamp tick could keep its
// size and times (Git's "racily clean" problem).
const RACY_MS = 2000n;

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export class HashCache {
  readonly #entries = new Map<string, { identity: FileIdentity; digest: FileDigest }>();

  get(path: string, identity: FileIdentity): FileDigest | null {
    const hit = this.#entries.get(path);
    return hit && sameIdentity(hit.identity, identity) ? hit.digest : null;
  }

  set(path: string, identity: FileIdentity, digest: FileDigest, nowMs: number): void {
    const cutoff = (BigInt(Math.floor(nowMs)) - RACY_MS) * 1_000_000n;
    if (identity.mtimeNs >= cutoff || identity.ctimeNs >= cutoff) {
      this.#entries.delete(path);
      return;
    }
    this.#entries.set(path, { identity, digest });
  }

  // Forget files no longer in scope.
  retain(paths: ReadonlySet<string>): void {
    for (const p of this.#entries.keys()) if (!paths.has(p)) this.#entries.delete(p);
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface WorkingStatus {
  changes: StatusChange[];
  counts: { total: number; added: number; modified: number; deleted: number; renamed: number };
  unsupported: UnsupportedEntry[];
  blockers: RepoBlocker[];
}

const isBlobMode = (mode: string) => mode === '100644' || mode === '100755';

export async function workingStatus(args: {
  repo: GitRepo;
  workspace: Workspace;
  probe: RepoProbe;
  config: ProjectConfig;
  tipFiles: readonly GitTreeEntry[];
  cache: HashCache;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<WorkingStatus> {
  const { repo, workspace, probe, config, cache, nowMs, signal } = args;
  const scan = await scanScope(repo, workspace, excludeRules(config), signal);
  const attrs = attributeVerdict(
    await repo.checkAttributes(
      scan.files.map((f) => f.path),
      signal,
    ),
  );
  const digests = await mapLimit(
    scan.files,
    8,
    async (f: ScopeFile) => {
      const hit = cache.get(f.path, f.identity);
      if (hit) return hit;
      const r = await workspace.hash(f.path, f.identity, signal);
      if (r.changed) return null;
      cache.set(f.path, f.identity, r.digest, nowMs);
      return r.digest;
    },
    signal,
  );
  cache.retain(new Set(scan.files.map((f) => f.path)));

  const working: TreeFileAt[] = [];
  const changing: string[] = [];
  const withCR: string[] = [];
  scan.files.forEach((f, i) => {
    const d = digests[i];
    if (!d) {
      changing.push(f.path);
      return;
    }
    if (d.hasCR && attrs.convertingPaths.has(f.path)) withCR.push(f.path);
    working.push({
      path: f.path,
      mode: blobMode(d.executable, f.tracked, probe.trustExecutableBit),
      oid: d.oid,
      size: d.size,
    });
  });
  const skip = new Set([...scan.unsupported.map((u) => u.path), ...changing]);
  const before = args.tipFiles
    .filter((e) => isBlobMode(e.mode) && !skip.has(e.path))
    .map((e): TreeFileAt => ({ path: e.path, mode: e.mode, oid: e.oid, size: e.size }));
  const { changes } = diffTreeFiles(before, working);
  const inTip = new Set(args.tipFiles.map((e) => e.path));
  // A file that changed while it was read is being written: it differs.
  const all: StatusChange[] = [
    ...changes.map(({ path, change, previousPath }) => ({ path, change, previousPath })),
    ...changing.map((path): StatusChange => ({
      path,
      change: inTip.has(path) ? 'modified' : 'added',
      previousPath: null,
    })),
  ].sort((a, b) => compareGitPaths(a.path, b.path));
  const count = (kind: StatusChange['change']) => all.filter((c) => c.change === kind).length;
  const lineEndings = lineEndingBlocker(withCR);
  return {
    changes: all,
    counts: {
      total: all.length,
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      renamed: count('renamed'),
    },
    unsupported: scan.unsupported,
    blockers: [...scan.blockers, ...attrs.blockers, ...(lineEndings ? [lineEndings] : [])],
  };
}
