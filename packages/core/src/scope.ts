import {
  DEFAULT_EXCLUDE_DIR_NAMES,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
  DtError,
  PROJECT_CONFIG_FILE,
  canonicalJson,
  isSafeRelativePath,
  type JsonValue,
  type ProjectConfig,
  type RepoBlocker,
  type RepoBusyReason,
  type RepoUnsupportedReason,
  type UnsupportedEntry,
} from '@draft-tide/contracts';
import { compareGitPaths, findPathCollisions } from './paths.ts';
import { sha256Hex } from './text.ts';
import type {
  ExcludeRules,
  FileIdentity,
  GitBlobMode,
  GitOid,
  GitRepo,
  IndexEntry,
  PathAttributes,
  RepoProbe,
  Workspace,
} from './ports.ts';

// The scope rule (M1 plan §6.2), `git add -A` semantics:
// - every tracked file is in;
// - an untracked file is in unless .gitignore, info/exclude, the default
//   excludes or the project's own excludes leave it out;
// - `.drafttide.json` is always in, even when .gitignore lists it.
// Excludes only gate untracked files, so neither a default nor a project rule
// can drop a tracked file (that would be a silent deletion). Anything in scope
// that can't be saved is reported, never skipped.

const SAMPLE = 5;

type ScopeExcludes = Pick<ProjectConfig, 'excludeDirNames' | 'excludeFilePatterns'>;

export const DEFAULT_EXCLUDE_RULES: ExcludeRules = {
  dirNames: DEFAULT_EXCLUDE_DIR_NAMES,
  filePatterns: DEFAULT_EXCLUDE_FILE_PATTERNS,
};

// The defaults plus the project's own excludes.
export function excludeRules(config?: ScopeExcludes | null): ExcludeRules {
  return {
    dirNames: [...new Set([...DEFAULT_EXCLUDE_DIR_NAMES, ...(config?.excludeDirNames ?? [])])],
    filePatterns: [...new Set([...DEFAULT_EXCLUDE_FILE_PATTERNS, ...(config?.excludeFilePatterns ?? [])])],
  };
}

export interface ScopeFile {
  path: string;
  // The index entry, for tracked files.
  tracked: IndexEntry | null;
  size: number;
  executable: boolean;
  identity: FileIdentity;
}

export interface ScopeScan {
  // In scope and present, in Git path order.
  files: ScopeFile[];
  // Tracked, but gone from disk: the next version deletes them.
  deleted: string[];
  // Blob ids of every tracked file, present or not: content Git keeps (gc
  // never prunes what the index references), so a renamed or copied file
  // needs no new object.
  indexedBlobs: Set<GitOid>;
  unsupported: UnsupportedEntry[];
  blockers: RepoBlocker[];
}

// Collects blockers one per reason, with a count and a few sample paths.
class BlockerSet {
  readonly #byKey = new Map<string, { blocker: RepoBlocker; paths: string[]; count: number }>();

  add(code: 'REPO_UNSUPPORTED', reason: RepoUnsupportedReason, path?: string): void;
  add(code: 'REPO_BUSY', reason: RepoBusyReason, path?: string): void;
  add(code: RepoBlocker['code'], reason: RepoUnsupportedReason | RepoBusyReason, path?: string): void {
    const key = `${code}:${reason}`;
    let entry = this.#byKey.get(key);
    if (!entry) {
      const blocker = { code, reason, details: {} } as RepoBlocker;
      this.#byKey.set(key, (entry = { blocker, paths: [], count: 0 }));
    }
    if (path === undefined) return;
    entry.count++;
    if (entry.paths.length < SAMPLE) entry.paths.push(path);
  }

  list(): RepoBlocker[] {
    return [...this.#byKey.values()].map(({ blocker, paths, count }) =>
      count > 0 ? { ...blocker, details: { ...blocker.details, count, sample: paths } } : blocker,
    );
  }
}

export async function scanScope(
  repo: GitRepo,
  workspace: Workspace,
  rules: ExcludeRules,
  signal?: AbortSignal,
): Promise<ScopeScan> {
  const [index, untracked] = await Promise.all([repo.listIndex(signal), repo.listUntracked(rules, signal)]);
  const blockers = new BlockerSet();
  const unsupported: UnsupportedEntry[] = [];
  const tracked = new Map<string, IndexEntry>();

  for (const e of index.entries) {
    if (e.stage !== 0) blockers.add('REPO_BUSY', 'unmerged-entries', e.path);
    else if (e.mode === '160000') blockers.add('REPO_UNSUPPORTED', 'gitlink-in-index', e.path);
    else if (e.flag !== null) blockers.add('REPO_UNSUPPORTED', 'index-flags', e.path);
    else if (e.mode === '120000') unsupported.push({ path: e.path, kind: 'symlink' });
    else if (e.mode === '100644' || e.mode === '100755') tracked.set(e.path, e);
    else unsupported.push({ path: e.path, kind: 'special' });
  }
  for (const p of untracked.nestedRepos) blockers.add('REPO_UNSUPPORTED', 'nested-repo', p);
  for (const p of [...index.nonUtf8, ...untracked.nonUtf8]) unsupported.push({ path: p, kind: 'non-utf8-name' });

  // Unmerged paths appear once per stage; they are blockers, not candidates.
  const candidates = new Set<string>([...tracked.keys(), ...untracked.files, PROJECT_CONFIG_FILE]);
  const named: string[] = [];
  for (const p of candidates) {
    if (isSafeRelativePath(p)) named.push(p);
    else unsupported.push({ path: p, kind: 'invalid-name' });
  }
  named.sort(compareGitPaths);

  const inspected = await workspace.inspect(named, signal);
  const files: ScopeFile[] = [];
  const deleted: string[] = [];
  named.forEach((path, i) => {
    const r = inspected[i];
    if (!r) throw new DtError('INTERNAL_ERROR', 'inspect returned too few results');
    const entry = tracked.get(path) ?? null;
    if (r.kind === 'file') {
      files.push({ path, tracked: entry, size: r.size, executable: r.executable, identity: r.identity });
    } else if (r.kind === 'missing') {
      // An untracked path that vanished since the listing is simply not there.
      if (entry) deleted.push(path);
    } else {
      unsupported.push({ path, kind: r.reason });
    }
  });

  for (const group of findPathCollisions(files.map((f) => f.path))) {
    for (const path of group) unsupported.push({ path, kind: 'path-collision' });
  }
  unsupported.sort((a, b) => compareGitPaths(a.path, b.path) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const indexedBlobs = new Set([...tracked.values()].map((e) => e.oid));
  return { files, deleted, indexedBlobs, unsupported, blockers: blockers.list() };
}

// The executable bit as Git would record it. Where the filesystem can't be
// trusted with it, a tracked file keeps its index mode and a new file is
// 100644, which is what `git add` does with core.fileMode=false.
export function blobMode(executable: boolean, tracked: IndexEntry | null, trustExecutableBit: boolean): GitBlobMode {
  if (trustExecutableBit) return executable ? '100755' : '100644';
  return tracked?.mode === '100755' ? '100755' : '100644';
}

export interface AttributeVerdict {
  blockers: RepoBlocker[];
  // Explicit `text` or `eol`: Git converts line endings for these on add, so
  // raw bytes containing CR would make `git status` report them modified.
  convertingPaths: Set<string>;
}

const isSet = (v: string) => v !== 'unspecified' && v !== 'unset';

// Attributes that make Git rewrite content on add refuse the repo: raw bytes
// in history would disagree with what `git status` sees (single-repo spike
// C5–C8). `text=auto` and core.autocrlf are fine: Git keeps CRLF that is
// already in the index.
export function attributeVerdict(attrs: ReadonlyMap<string, PathAttributes>): AttributeVerdict {
  const blockers = new BlockerSet();
  const convertingPaths = new Set<string>();
  for (const [path, a] of [...attrs].sort(([x], [y]) => compareGitPaths(x, y))) {
    if (isSet(a.filter)) {
      blockers.add('REPO_UNSUPPORTED', a.filter.toLowerCase() === 'lfs' ? 'git-lfs' : 'attribute-filter', path);
    } else if (isSet(a.ident) || isSet(a.workingTreeEncoding)) {
      blockers.add('REPO_UNSUPPORTED', 'attribute-filter', path);
    }
    const eolSet = a.eol === 'lf' || a.eol === 'crlf';
    if (a.text === 'set' || (eolSet && a.text === 'unspecified')) convertingPaths.add(path);
  }
  return { blockers: blockers.list(), convertingPaths };
}

export function lineEndingBlocker(pathsWithCR: readonly string[]): RepoBlocker | null {
  if (pathsWithCR.length === 0) return null;
  const sorted = [...pathsWithCR].sort(compareGitPaths);
  return {
    code: 'REPO_UNSUPPORTED',
    reason: 'line-ending-normalization',
    details: { count: sorted.length, sample: sorted.slice(0, SAMPLE) },
  };
}

// Throws the error for the first problem: an unsupported repo form beats a
// busy one (retrying won't fix it), and both beat unsupported entries.
export function assertNoBlockers(blockers: readonly RepoBlocker[]): void {
  const first = blockers.find((b) => b.code === 'REPO_UNSUPPORTED') ?? blockers[0];
  if (!first) return;
  const message =
    first.code === 'REPO_BUSY'
      ? 'another Git operation is in progress in this folder; finish it, then try again'
      : `this folder's Git repository can't be used as it is (${first.reason})`;
  throw new DtError(first.code, message, {
    reason: first.reason,
    blockers: blockers as unknown as JsonValue,
  });
}

export function assertSupportedEntries(unsupported: readonly UnsupportedEntry[]): void {
  if (unsupported.length === 0) return;
  throw new DtError('UNSUPPORTED_ENTRY', 'some items in the folder cannot be saved; exclude or fix them first', {
    count: unsupported.length,
    entries: unsupported.slice(0, 50) as unknown as JsonValue,
  });
}

export function assertUsable(probe: RepoProbe): void {
  assertNoBlockers(probe.blockers);
}

// ---- scope review (shown before a folder is bound, M1 plan §6.2)

export interface Excerpt {
  count: number;
  sample: string[];
}

export type EntryFileStatus = 'included' | 'excluded' | 'missing' | 'unsupported';

export interface ScopeReview {
  probe: RepoProbe;
  // Every reason this folder can't be saved right now: repo form, repo state,
  // attributes.
  blockers: RepoBlocker[];
  included: { files: number; bytes: number; largest: { path: string; size: number }[] };
  // Every included path, in Git order (stays inside the Engine).
  includedPaths: string[];
  deleted: Excerpt;
  unsupported: { count: number; entries: UnsupportedEntry[] };
  // Everything left out (collapsed to folders where Git can), and the part the
  // default excludes are responsible for.
  excluded: Excerpt;
  excludedByDefaults: Excerpt;
  entryFiles: { path: string; status: EntryFileStatus }[];
  // Pages the user might pick as the entry: included HTML, shallowest first.
  entryCandidates: string[];
  // Names what was reviewed: the repo's branch and tip, every path in scope
  // (not its content), the deletions and everything that blocks. Connecting
  // the folder compares it again (SCOPE_CHANGED).
  fingerprint: string;
}

async function reviewFingerprint(
  probe: RepoProbe,
  blockers: readonly RepoBlocker[],
  scan: Pick<ScopeScan, 'files' | 'deleted' | 'unsupported'> | null,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      repo: { hasRepo: probe.hasRepo, headRef: probe.headRef, tip: probe.tip },
      blockers: blockers.map((b) => `${b.code}:${b.reason}`).sort(),
      included: scan?.files.map((f) => f.path) ?? null,
      deleted: scan?.deleted ?? null,
      unsupported: scan?.unsupported.map((u) => `${u.kind}:${u.path}`) ?? null,
    }),
  );
}

const REVIEW_SAMPLE = 50;
const REVIEW_UNSUPPORTED = 200;
const LARGEST = 10;
const ENTRY_CANDIDATES = 20;

function excerpt(paths: readonly string[]): Excerpt {
  return { count: paths.length, sample: [...paths].sort(compareGitPaths).slice(0, REVIEW_SAMPLE) };
}

// Read-only: lists, lstat()s and reads only the files whose attributes need a
// line-ending check. Nothing in the folder or its `.git` is written. A folder
// whose repo form is unsupported gets no scope scan: it can't be bound as it
// is, and listing it may not even work.
export async function reviewScope(
  repo: GitRepo,
  workspace: Workspace,
  config: Pick<ProjectConfig, 'entryFiles' | 'excludeDirNames' | 'excludeFilePatterns'> | null,
  signal?: AbortSignal,
): Promise<ScopeReview> {
  const probe = await repo.probe(signal);
  const empty: ScopeReview = {
    probe,
    blockers: probe.blockers,
    included: { files: 0, bytes: 0, largest: [] },
    includedPaths: [],
    deleted: excerpt([]),
    unsupported: { count: 0, entries: [] },
    excluded: excerpt([]),
    excludedByDefaults: excerpt([]),
    entryFiles: (config?.entryFiles ?? []).map((path) => ({ path, status: 'missing' as const })),
    entryCandidates: [],
    fingerprint: '',
  };
  if (probe.blockers.some((b) => b.code === 'REPO_UNSUPPORTED')) {
    return { ...empty, fingerprint: await reviewFingerprint(probe, probe.blockers, null) };
  }

  const rules = excludeRules(config);
  const scan = await scanScope(repo, workspace, rules, signal);
  const attrs = attributeVerdict(await repo.checkAttributes(scan.files.map((f) => f.path)));
  const withCR: string[] = [];
  for (const f of scan.files) {
    if (!attrs.convertingPaths.has(f.path)) continue;
    const r = await workspace.hash(f.path, f.identity, signal);
    // A file that changes under review is checked again when it is saved.
    if (!r.changed && r.digest.hasCR) withCR.push(f.path);
  }
  const lineEndings = lineEndingBlocker(withCR);
  const [excluded, byDefaults] = await Promise.all([
    repo.listExcluded(rules, { standard: true }, signal),
    repo.listExcluded(DEFAULT_EXCLUDE_RULES, { standard: false }, signal),
  ]);

  const included = new Set(scan.files.map((f) => f.path));
  const unsupportedPaths = new Set(scan.unsupported.map((u) => u.path));
  const entryPaths = config?.entryFiles ?? [];
  const entryProbe = await workspace.inspect(entryPaths, signal);
  const entryFiles = entryPaths.map((path, i) => {
    let status: EntryFileStatus = 'missing';
    if (included.has(path)) status = 'included';
    else if (unsupportedPaths.has(path)) status = 'unsupported';
    else if (entryProbe[i]?.kind === 'file') status = 'excluded';
    return { path, status };
  });

  const depth = (p: string) => p.split('/').length;
  const blockers = [...probe.blockers, ...scan.blockers, ...attrs.blockers, ...(lineEndings ? [lineEndings] : [])];
  return {
    probe,
    blockers,
    included: {
      files: scan.files.length,
      bytes: scan.files.reduce((n, f) => n + f.size, 0),
      largest: [...scan.files]
        .sort((a, b) => b.size - a.size || compareGitPaths(a.path, b.path))
        .slice(0, LARGEST)
        .map((f) => ({ path: f.path, size: f.size })),
    },
    includedPaths: scan.files.map((f) => f.path),
    deleted: excerpt(scan.deleted),
    unsupported: { count: scan.unsupported.length, entries: scan.unsupported.slice(0, REVIEW_UNSUPPORTED) },
    excluded: excerpt([...excluded.entries, ...excluded.nonUtf8]),
    excludedByDefaults: excerpt([...byDefaults.entries, ...byDefaults.nonUtf8]),
    entryFiles,
    entryCandidates: scan.files
      .map((f) => f.path)
      .filter((p) => /\.html?$/i.test(p))
      .sort((a, b) => depth(a) - depth(b) || compareGitPaths(a, b))
      .slice(0, ENTRY_CANDIDATES),
    fingerprint: await reviewFingerprint(probe, blockers, scan),
  };
}
