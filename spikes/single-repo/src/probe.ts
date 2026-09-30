import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ErrorCode } from './errors.ts';
import { RepoGit, spawnGit, sanitizedEnv, type GitRuntime } from './git.ts';

export interface Blocker {
  code: ErrorCode;
  reason: string;
  details?: Record<string, unknown>;
}

export interface RepoProbe {
  root: string;
  gitDir: string | null;
  nestedIn: string | null;
  headRef: string | null;
  tip: string | null;
  unborn: boolean;
  blockers: Blocker[];
  warnings: string[];
  // Config keys that can make Git run programs or redirect traffic. We never
  // honor them (command-line overrides for local work, an ephemeral git dir for
  // network work), but the user should know the repo carries them.
  dangerousConfigKeys: string[];
  hooks: string[];
}

const DANGEROUS_KEY =
  /^(core\.(fsmonitor|hookspath|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand|attributesfile|excludesfile)|diff\.external|credential\..+|http\..+|gpg\..+|alias\..+|uploadpack\..+|receive\..+|protocol\..+|include\.path|includeif\..+\.path|filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|merge\..+\.driver|url\..+\.(insteadof|pushinsteadof)|remote\..+\.(proxy|receivepack|uploadpack|vcs))$/i;

const BUSY_FILES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG'];
const BUSY_DIRS = ['rebase-merge', 'rebase-apply', 'sequencer'];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function findAncestorRepo(root: string): Promise<string | null> {
  let dir = dirname(root);
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Parses `git config --file <config> --list -z` without executing anything.
async function readRepoConfig(rt: GitRuntime, root: string, configPath: string): Promise<Map<string, string[]>> {
  const r = await spawnGit(rt, ['config', '--file', configPath, '--list', '-z'], root, sanitizedEnv(rt), { allowExitCodes: [1] });
  const map = new Map<string, string[]>();
  for (const rec of r.stdout.split('\0')) {
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

// Static, read-only look at the repository: which forms we refuse, what state
// it is in, and what hazards its config carries. Nothing here writes.
export async function probeRepo(rt: GitRuntime, root: string): Promise<RepoProbe> {
  const probe: RepoProbe = { root, gitDir: null, nestedIn: null, headRef: null, tip: null, unborn: false, blockers: [], warnings: [], dangerousConfigKeys: [], hooks: [] };
  const gitDir = join(root, '.git');
  let st;
  try {
    st = await lstat(gitDir);
  } catch {
    st = null;
  }
  if (!st) {
    probe.nestedIn = await findAncestorRepo(root);
    if (probe.nestedIn) probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'inside-another-repo' });
    return probe;
  }
  probe.gitDir = gitDir;
  if (st.isSymbolicLink()) {
    probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'dot-git-is-symlink' });
    return probe;
  }
  if (st.isFile()) {
    probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'linked-worktree-or-submodule' });
    return probe;
  }
  // Explicit --git-dir skips Git's own "dubious ownership" check, so repeat it.
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'foreign-owner' });
    return probe;
  }

  const cfg = await readRepoConfig(rt, root, join(gitDir, 'config'));
  const first = (k: string): string | undefined => cfg.get(k)?.at(-1);
  if (first('extensions.objectformat')?.toLowerCase() === 'sha256') probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'sha256-object-format' });
  if (first('extensions.refstorage')?.toLowerCase() === 'reftable') probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'reftable' });
  if (first('extensions.partialclone') || [...cfg.entries()].some(([k, v]) => /^remote\..+\.promisor$/.test(k) && v.at(-1) === 'true')) {
    probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'partial-clone' });
  }
  if (first('core.sparsecheckout') === 'true') probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'sparse-checkout' });
  if (first('core.bare') === 'true') probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'bare-repo' });
  probe.dangerousConfigKeys = [...cfg.keys()].filter((k) => DANGEROUS_KEY.test(k)).sort();

  if (await exists(join(gitDir, 'shallow'))) probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'shallow-clone' });

  try {
    probe.hooks = (await readdir(join(gitDir, 'hooks'))).filter((n) => !n.endsWith('.sample')).sort();
  } catch {
    probe.hooks = [];
  }
  if (probe.hooks.length) probe.warnings.push(`repo has hooks (${probe.hooks.join(', ')}); Draft Tide never runs them`);

  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  const m = /^ref: (refs\/heads\/.+)$/.exec(head);
  if (m?.[1]) probe.headRef = m[1];
  else probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'detached-head' });

  for (const f of BUSY_FILES) if (await exists(join(gitDir, f))) probe.blockers.push({ code: 'REPO_BUSY', reason: `in-progress:${f}` });
  for (const d of BUSY_DIRS) if (await exists(join(gitDir, d))) probe.blockers.push({ code: 'REPO_BUSY', reason: `in-progress:${d}` });

  const git = new RepoGit(rt, root);
  if (probe.headRef) {
    const r = await git.run(['for-each-ref', '--format=%(objectname)', probe.headRef]);
    probe.tip = r.stdout.trim() || null;
    probe.unborn = probe.tip === null;
  }
  // skip-worktree ("S") and assume-unchanged (lowercase) entries make the
  // index lie about the working files; a snapshot would disagree with `git status`.
  const flags = await git.run(['ls-files', '-v', '-z']);
  const flagged = flags.stdout.split('\0').filter((e) => e && (e[0] === 'S' || /[a-z]/.test(e[0] ?? '')));
  if (flagged.length) probe.blockers.push({ code: 'REPO_UNSUPPORTED', reason: 'index-flags', details: { count: flagged.length, sample: flagged.slice(0, 3).map((e) => e.slice(2)) } });
  return probe;
}
