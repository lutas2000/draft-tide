import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError } from '@draft-tide/contracts';
import type {
  ExcludeRules,
  GitHistory,
  GitListing,
  GitOid,
  GitRepo,
  IndexEntry,
  PathAttributes,
  ProjectGit,
  RepoProbe,
} from '@draft-tide/core';
import { createHistory, type HistoryTestHooks } from './history.ts';
import { probeRepo } from './probe.ts';
import { runGit, streamGit, type GitOutput, type RunOptions } from './process.ts';
import { HARDENING, type GitRuntime } from './runtime.ts';

export const OID_PATTERN = /^[0-9a-f]{40}$/;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lossyUtf8 = new TextDecoder('utf-8');

// Git paths are bytes. Valid UTF-8 becomes a path; anything else is reported
// (lossily) as a name that can't be saved.
function decodePath(bytes: Uint8Array): { path: string } | { invalid: string } {
  try {
    return { path: strictUtf8.decode(bytes) };
  } catch {
    return { invalid: lossyUtf8.decode(bytes) };
  }
}

function excludeArgs(rules: ExcludeRules): string[] {
  return [...rules.dirNames.map((d) => `--exclude=${d}/`), ...rules.filePatterns.map((p) => `--exclude=${p}`)];
}

export interface OpenGitRepoOptions {
  // For a folder without `.git` (scope review before `git init`): an empty
  // git dir elsewhere, so listings see the folder's .gitignore files without
  // anything being written into the folder. See createScratchGitDir. Such a
  // repo only lists: every history operation refuses.
  scratchGitDir?: string;
  // Tests only: pause or fail at a point inside publishing.
  testHooks?: HistoryTestHooks;
}

// History operations of a repo opened on a scratch git dir: refused, so
// nothing can ever be written to a git dir that isn't the project's.
function refusingHistory(): GitHistory {
  const refuse = (): never => {
    throw new DtError('INTERNAL_ERROR', 'a scratch git dir only lists the folder');
  };
  const all: Record<keyof GitHistory, () => never> = {
    init: refuse,
    writeBlobs: refuse,
    prepareIndex: refuse,
    prepareIndexFromTree: refuse,
    discardPreparedIndex: refuse,
    createCommit: refuse,
    publish: refuse,
    finishPublish: refuse,
    indexLock: refuse,
    releaseIndexLock: refuse,
    preparedIndexes: refuse,
    readRef: refuse,
    readCommits: refuse,
    firstParentLine: refuse,
    listTree: refuse,
    lookupPath: refuse,
    streamBlob: refuse,
    isAncestor: refuse,
  };
  return all;
}

// One design repo: explicit --git-dir and --work-tree (no discovery), the
// hardening on every call, the folder as cwd so Git reports root-relative
// paths. Only named operations; there is no way to pass arbitrary arguments.
export function openGitRepo(rt: GitRuntime, root: string, options: OpenGitRepoOptions = {}): ProjectGit {
  const gitDir = options.scratchGitDir ?? join(root, '.git');
  const prefix = [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...HARDENING];
  const run = (args: string[], opts: RunOptions = {}): Promise<GitOutput> =>
    runGit(rt, [...prefix, ...args], root, opts);
  const history = options.scratchGitDir
    ? refusingHistory()
    : createHistory({
        rt,
        root,
        gitDir,
        run,
        stream: (args, signal) => streamGit(rt, [...prefix, ...args], root, { signal }),
        hooks: options.testHooks,
      });

  async function listPaths(args: string[], signal?: AbortSignal): Promise<GitListing<string>> {
    const entries: string[] = [];
    const nonUtf8: string[] = [];
    await run(args, {
      signal,
      onRecord: (rec) => {
        if (rec.length === 0) return;
        const d = decodePath(rec);
        if ('path' in d) entries.push(d.path);
        else nonUtf8.push(d.invalid);
      },
    });
    return { entries, nonUtf8 };
  }

  const scope: GitRepo = {
    root,

    probe(signal?: AbortSignal): Promise<RepoProbe> {
      return probeRepo(root, run, signal);
    },

    // `ls-files -s -v`: "<tag> <mode> <oid> <stage>\t<path>". The tag is S for
    // skip-worktree and lowercase for assume-unchanged.
    async listIndex(signal?: AbortSignal): Promise<GitListing<IndexEntry>> {
      const entries: IndexEntry[] = [];
      const nonUtf8: string[] = [];
      await run(['ls-files', '--stage', '-v', '-z'], {
        signal,
        onRecord: (rec) => {
          if (rec.length === 0) return;
          const tab = rec.indexOf(9);
          const head = rec.subarray(0, tab).toString('latin1');
          const m = /^(\S) (\d{6}) ([0-9a-f]{40}) (\d)$/.exec(head);
          if (tab < 0 || !m) throw new DtError('GIT_FAILED', 'unexpected ls-files output');
          const [, tag = '', mode = '', oid = '', stage = '0'] = m;
          const d = decodePath(rec.subarray(tab + 1));
          if ('invalid' in d) {
            nonUtf8.push(d.invalid);
            return;
          }
          const flag =
            tag.toUpperCase() === 'S' ? 'skip-worktree' : tag !== tag.toUpperCase() ? 'assume-unchanged' : null;
          entries.push({ path: d.path, mode, oid, stage: Number(stage), flag });
        },
      });
      return { entries, nonUtf8 };
    },

    async listUntracked(rules: ExcludeRules, signal?: AbortSignal) {
      const listing = await listPaths(
        ['ls-files', '-z', '--others', '--exclude-standard', ...excludeArgs(rules)],
        signal,
      );
      const files: string[] = [];
      const nestedRepos: string[] = [];
      // Git lists an untracked repository inside the folder as "dir/".
      for (const p of listing.entries) (p.endsWith('/') ? nestedRepos : files).push(p);
      return { files, nestedRepos, nonUtf8: listing.nonUtf8 };
    },

    async listExcluded(rules: ExcludeRules, options: { standard: boolean }, signal?: AbortSignal) {
      const args = excludeArgs(rules);
      if (!options.standard && args.length === 0) return { entries: [], nonUtf8: [] };
      const listing = await listPaths(
        [
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--directory',
          ...(options.standard ? ['--exclude-standard'] : []),
          ...args,
        ],
        signal,
      );
      // Git also names a folder that holds nothing but excluded content
      // ("deep/" next to "deep/node_modules/"); the specific entry says more.
      const sorted = [...listing.entries].sort();
      const entries = sorted.filter((p, i) => !(p.endsWith('/') && sorted[i + 1]?.startsWith(p)));
      return { entries, nonUtf8: listing.nonUtf8 };
    },

    // Output: path NUL attribute NUL value NUL, for every path and attribute.
    async checkAttributes(paths: readonly string[], signal?: AbortSignal) {
      const out = new Map<string, PathAttributes>();
      if (paths.length === 0) return out;
      let field = 0;
      let path = '';
      let attr = '';
      await run(['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'ident', 'working-tree-encoding'], {
        input: `${paths.join('\0')}\0`,
        signal,
        onRecord: (rec) => {
          const value = rec.toString('utf8');
          if (field === 0) path = value;
          else if (field === 1) attr = value;
          else {
            let a = out.get(path);
            if (!a) {
              a = {
                filter: 'unspecified',
                text: 'unspecified',
                eol: 'unspecified',
                ident: 'unspecified',
                workingTreeEncoding: 'unspecified',
              };
              out.set(path, a);
            }
            if (attr === 'filter') a.filter = value;
            else if (attr === 'text') a.text = value;
            else if (attr === 'eol') a.eol = value;
            else if (attr === 'ident') a.ident = value;
            else if (attr === 'working-tree-encoding') a.workingTreeEncoding = value;
          }
          field = (field + 1) % 3;
        },
      });
      return out;
    },

    async existingBlobs(oids: readonly GitOid[], signal?: AbortSignal) {
      const found = new Set<GitOid>();
      const wanted = [...new Set(oids)];
      if (wanted.length === 0) return found;
      if (!wanted.every((o) => OID_PATTERN.test(o))) throw new DtError('INTERNAL_ERROR', 'invalid object id');
      const r = await run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        input: `${wanted.join('\n')}\n`,
        // One short line per id: proportional to the project, not a quota.
        maxOutputBytes: wanted.length * 64 + 1024,
        timeoutMs: 10 * 60_000,
        signal,
      });
      for (const line of r.stdout.toString('utf8').split('\n')) {
        const [oid, type] = line.split(' ');
        if (oid && type === 'blob' && OID_PATTERN.test(oid)) found.add(oid);
      }
      return found;
    },
  };
  return { ...scope, ...history };
}

// An empty git dir for listing a folder that has no `.git` yet. The caller
// owns it and removes it with the returned function.
export async function createScratchGitDir(
  rt: GitRuntime,
  parentDir: string,
): Promise<{ gitDir: string; remove: () => Promise<void> }> {
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parentDir, 'scratch-'));
  const remove = () => rm(dir, { recursive: true, force: true });
  try {
    await runGit(rt, ['init', '--quiet', '--bare', '--template=', dir], dir);
  } catch (e) {
    await remove();
    throw e;
  }
  return { gitDir: dir, remove };
}
