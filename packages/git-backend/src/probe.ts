import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DtError,
  type JsonValue,
  type RepoBlocker,
  type RepoBusyReason,
  type RepoUnsupportedReason,
  type RepoWarning,
} from '@draft-tide/contracts';
import type { RepoProbe } from '@draft-tide/core';
import type { GitOutput, RunOptions } from './process.ts';

// A read-only look at the folder's repository: the forms Draft Tide refuses
// before writing anything (M1 plan §6.2), the state it is in, and the hazards
// its config carries. Index-level checks (unmerged entries, gitlinks,
// skip-worktree) and attribute checks happen with the scope scan.

type Run = (args: string[], options?: RunOptions) => Promise<GitOutput>;

// Keys that can make Git run a program or send traffic elsewhere. Draft Tide
// never honors them; the warning lets the user know the repo carries them.
const DANGEROUS_KEY =
  /^(core\.(fsmonitor|hookspath|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand|attributesfile|excludesfile)|diff\.external|credential\..+|http\..+|gpg\..+|alias\..+|uploadpack\..+|receive\..+|protocol\..+|include\.path|includeif\..+\.path|filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|merge\..+\.driver|url\..+\.(insteadof|pushinsteadof)|remote\..+\.(proxy|receivepack|uploadpack|vcs))$/i;

// Extensions Git understands in a version-1 repository. Anything else makes
// Git itself refuse the repo.
const KNOWN_EXTENSIONS = new Set([
  'noop',
  'noop-v1',
  'preciousobjects',
  'partialclone',
  'worktreeconfig',
  'objectformat',
  'compatobjectformat',
  'refstorage',
]);

const BUSY_MARKERS: readonly [string, RepoBusyReason][] = [
  ['MERGE_HEAD', 'merge-in-progress'],
  ['rebase-merge', 'rebase-in-progress'],
  ['rebase-apply', 'rebase-in-progress'],
  ['REBASE_HEAD', 'rebase-in-progress'],
  ['CHERRY_PICK_HEAD', 'cherry-pick-in-progress'],
  ['REVERT_HEAD', 'revert-in-progress'],
  ['sequencer', 'sequencer-in-progress'],
  ['BISECT_LOG', 'bisect-in-progress'],
];

// refs/heads/<name>, with Git's ref-name rules (check-ref-format) applied
// conservatively.
export function isBranchRef(ref: string): boolean {
  if (!ref.startsWith('refs/heads/') || ref.length > 1024) return false;
  const name = ref.slice('refs/heads/'.length);
  if (name === '' || name === '@' || name.endsWith('/') || name.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return name.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

function gitBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === '' || s === 'true' || s === 'yes' || s === 'on' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === 'off' || s === '0') return false;
  return undefined;
}

// `git config --file … --list -z`: parsed without executing anything, and
// without following include.path (Git doesn't read extensions from includes).
async function readConfigFile(run: Run, file: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!(await lstatOrNull(file))) return map;
  const r = await run(['config', '--file', file, '--no-includes', '--list', '-z'], { okExitCodes: [1] });
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = (nl < 0 ? rec : rec.slice(0, nl)).toLowerCase();
    const value = nl < 0 ? '' : rec.slice(nl + 1);
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return map;
}

async function findEnclosingRepo(root: string): Promise<string | null> {
  let dir = dirname(root);
  for (;;) {
    if (await lstatOrNull(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export async function probeRepo(root: string, run: Run, signal?: AbortSignal): Promise<RepoProbe> {
  const rootStat = await lstatOrNull(root);
  if (!rootStat?.isDirectory()) {
    throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the design folder is not available');
  }
  const blockers: RepoBlocker[] = [];
  const warnings: RepoWarning[] = [];
  const unsupported = (reason: RepoUnsupportedReason, details: Record<string, JsonValue> = {}) =>
    blockers.push({ code: 'REPO_UNSUPPORTED', reason, details });
  const probe = (over: Partial<RepoProbe>): RepoProbe => ({
    hasRepo: true,
    headRef: null,
    branch: null,
    tip: null,
    trustExecutableBit: process.platform !== 'win32',
    blockers,
    warnings,
    ...over,
  });

  const gitDir = join(root, '.git');
  const st = await lstatOrNull(gitDir);
  if (!st) {
    // A plain folder; M1 requires the project root to be the repo root, so it
    // can't sit inside another repo (that repo would see ours as nested).
    const outer = await findEnclosingRepo(root);
    if (outer) unsupported('inside-another-repo', { repoRoot: outer });
    return probe({ hasRepo: false });
  }
  if (st.isSymbolicLink()) unsupported('dot-git-symlink');
  else if (st.isFile()) unsupported('linked-worktree-or-submodule');
  else if (!st.isDirectory()) unsupported('dot-git-special');
  // An explicit --git-dir skips Git's own ownership check (safe.directory),
  // so it is repeated here. Windows has no uid to compare.
  else if (typeof process.getuid === 'function' && st.uid !== process.getuid()) unsupported('foreign-owner');
  if (blockers.length > 0) return probe({});
  signal?.throwIfAborted();

  const config = await readConfigFile(run, join(gitDir, 'config'));
  const last = (key: string) => config.get(key)?.at(-1);
  if (gitBool(last('extensions.worktreeconfig'))) {
    for (const [k, v] of await readConfigFile(run, join(gitDir, 'config.worktree'))) config.set(k, v);
  }
  const version = Number(last('core.repositoryformatversion') ?? '0');
  if (version !== 0 && version !== 1) unsupported('unknown-repo-format', { repositoryFormatVersion: version });
  if (version === 1) {
    const unknown = [...config.keys()]
      .filter((k) => k.startsWith('extensions.'))
      .map((k) => k.slice('extensions.'.length))
      .filter((name) => !KNOWN_EXTENSIONS.has(name));
    if (unknown.length > 0) unsupported('unknown-repo-format', { extensions: unknown.slice(0, 5) });
  }
  if (last('extensions.objectformat')?.toLowerCase() === 'sha256') unsupported('sha256-object-format');
  if (last('extensions.refstorage')?.toLowerCase() === 'reftable') unsupported('reftable');
  const promisor = [...config].some(([k, v]) => /^remote\..+\.promisor$/.test(k) && gitBool(v.at(-1)) === true);
  if (last('extensions.partialclone') !== undefined || promisor) unsupported('partial-clone');
  if (gitBool(last('core.bare')) === true) unsupported('bare-repo');
  if (gitBool(last('core.sparsecheckout')) === true || gitBool(last('index.sparse')) === true) {
    unsupported('sparse-checkout');
  }
  if (await lstatOrNull(join(gitDir, 'shallow'))) unsupported('shallow-clone');

  const dangerous = [...config.keys()].filter((k) => DANGEROUS_KEY.test(k)).sort();
  if (dangerous.length > 0) warnings.push({ reason: 'dangerous-config', details: { keys: dangerous.slice(0, 50) } });
  let hookFiles: Dirent[] = [];
  try {
    hookFiles = await readdir(join(gitDir, 'hooks'), { withFileTypes: true });
  } catch {
    // No hooks directory.
  }
  const hooks = hookFiles
    .map((d) => d.name)
    .filter((n) => !n.endsWith('.sample'))
    .sort();
  if (hooks.length > 0) warnings.push({ reason: 'hooks-present', details: { hooks: hooks.slice(0, 50) } });
  if (await lstatOrNull(join(gitDir, 'objects', 'info', 'alternates'))) {
    warnings.push({ reason: 'alternates', details: {} });
  }

  for (const [marker, reason] of BUSY_MARKERS) {
    if (await lstatOrNull(join(gitDir, marker))) blockers.push({ code: 'REPO_BUSY', reason, details: {} });
  }
  const trustExecutableBit = process.platform !== 'win32' && gitBool(last('core.filemode')) !== false;
  // Formats Git may not even read are not worth asking about HEAD.
  if (blockers.some((b) => b.code === 'REPO_UNSUPPORTED')) return probe({ trustExecutableBit });

  const head = await run(['symbolic-ref', '--quiet', 'HEAD'], { okExitCodes: [1], signal });
  const headRef = head.exitCode === 0 ? head.stdout.toString('utf8').trim() : '';
  if (!isBranchRef(headRef)) {
    unsupported('detached-head');
    return probe({ trustExecutableBit });
  }
  const refs = await run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', headRef], { signal });
  let tip: string | null = null;
  for (const line of refs.stdout.toString('utf8').split('\n')) {
    const [name, oid, type] = line.split('\0');
    if (name !== headRef) continue;
    if (type !== 'commit' || !oid || !/^[0-9a-f]{40}$/.test(oid)) {
      throw new DtError('GIT_FAILED', 'the current branch does not point at a commit');
    }
    tip = oid;
  }
  return probe({ headRef, branch: headRef.slice('refs/heads/'.length), tip, trustExecutableBit });
}
