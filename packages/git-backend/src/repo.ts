import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError } from '@draft-tide/contracts';
import type {
  ExcludeRules,
  GitHistory,
  GitListing,
  GitOid,
  GitRemote,
  GitRepo,
  IndexEntry,
  PathAttributes,
  ProjectGit,
  PushObject,
  RepoProbe,
} from '@draft-tide/core';
import { createHistory, type HistoryTestHooks } from './history.ts';
import {
  TRACKING_PREFIX,
  fetchRemoteBranch,
  isSafeBranchName,
  listRemoteHeads,
  pushRemoteBranch,
  withNetwork,
} from './network.ts';
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
  // Where network operations make their ephemeral git dirs (the data
  // directory's tmp/). Without it the repo has no network operations.
  networkTmpDir?: string;
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

function refusingRemote(why: string): GitRemote {
  const refuse = (): never => {
    throw new DtError('INTERNAL_ERROR', why);
  };
  const all: Record<keyof GitRemote, () => never> = {
    remoteHeads: refuse,
    fetchBranch: refuse,
    pushBranch: refuse,
    trackingTip: refuse,
    clearTracking: refuse,
    objectsToPush: refuse,
    commitsBetween: refuse,
    mergeBase: refuse,
    readOrigin: refuse,
    setOrigin: refuse,
  };
  return all;
}

function assertOids(oids: readonly string[]): void {
  if (!oids.every((o) => OID_PATTERN.test(o))) throw new DtError('INTERNAL_ERROR', 'invalid object id');
}

function trackingRef(branch: string): string {
  if (!isSafeBranchName(branch))
    throw new DtError('INVALID_ARGUMENT', 'unsupported branch name', { reason: 'branch-name' });
  return `${TRACKING_PREFIX}${branch}`;
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

    // `count-objects -v`: the loose objects, the packs and any garbage, each
    // in KiB. Nothing is written.
    async objectStoreSize(signal?: AbortSignal) {
      const r = await run(['count-objects', '-v'], { signal, maxOutputBytes: 64 * 1024 });
      const text = r.stdout.toString('utf8');
      let kib = 0;
      for (const key of ['size', 'size-pack', 'size-garbage']) {
        const m = new RegExp(`^${key}: (\\d+)$`, 'm').exec(text);
        if (!m && key !== 'size-garbage') throw new DtError('GIT_FAILED', 'unexpected count-objects output');
        kib += Number(m?.[1] ?? 0);
      }
      return kib * 1024;
    },
  };
  const remote: GitRemote =
    options.scratchGitDir !== undefined
      ? refusingRemote('a scratch git dir only lists the folder')
      : options.networkTmpDir === undefined
        ? refusingRemote('this repo was opened without network operations')
        : createRemote(rt, root, gitDir, options.networkTmpDir, run);
  return { ...scope, ...history, ...remote };
}

// The network half of a design repo (network.ts) and the reads that go with
// it. Only objects and refs/remotes/draft-tide/* are written into the
// project's `.git`; `remote.origin.*` only through setOrigin.
function createRemote(
  rt: GitRuntime,
  root: string,
  gitDir: string,
  tmpDir: string,
  run: (args: string[], opts?: RunOptions) => Promise<GitOutput>,
): GitRemote {
  const objectsDir = join(gitDir, 'objects');
  const configFile = join(gitDir, 'config');

  async function setTracking(branch: string, oid: GitOid): Promise<void> {
    await run(['update-ref', '-m', 'draft-tide: remote', trackingRef(branch), oid]);
  }

  // rev-list over the commits reachable from tip and not from exclude, read
  // from stdin so nothing is parsed as an option or a revision expression.
  function revListInput(tip: GitOid, exclude: readonly GitOid[]): string {
    assertOids([tip, ...exclude]);
    return [tip, ...exclude.map((e) => `^${e}`)].join('\n') + '\n';
  }

  return {
    remoteHeads: (access, signal) =>
      withNetwork(rt, tmpDir, null, access, (net) => listRemoteHeads(net, access.url, signal)),

    async fetchBranch(access, branch, options = {}) {
      const known = await this.trackingTip(branch);
      const haves = [...new Set([...(options.haves ?? []), ...(known ? [known] : [])])];
      const tip = await withNetwork(rt, tmpDir, objectsDir, access, (net) =>
        fetchRemoteBranch(net, access.url, branch, haves, options.signal),
      );
      // What was there before is gone (deleted on GitHub, or another
      // repository): the tracking ref must not keep claiming it.
      if (tip !== null) await setTracking(branch, tip);
      else if (known !== null) await this.clearTracking(branch);
      return tip;
    },

    async pushBranch(access, branch, commit, signal) {
      const r = await withNetwork(rt, tmpDir, objectsDir, access, (net) =>
        pushRemoteBranch(net, access.url, branch, commit, signal),
      );
      await setTracking(branch, commit);
      return { created: r.created };
    },

    async trackingTip(branch) {
      const ref = trackingRef(branch);
      const out = await run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', ref]);
      for (const line of out.stdout.toString('utf8').split('\n')) {
        const [name, oid, type] = line.split('\0');
        if (name === ref && type === 'commit' && oid && OID_PATTERN.test(oid)) return oid;
      }
      return null;
    },

    async clearTracking(branch) {
      await run(['update-ref', '-m', 'draft-tide: remote', '-d', trackingRef(branch)]);
    },

    async objectsToPush(tip, exclude, signal) {
      let found: { oid: GitOid; path: string | null }[] = [];
      const input = revListInput(tip, exclude);
      try {
        // `-z` (Git 2.50+, the bundled Git has it): "<oid> NUL [path=<path> NUL]",
        // every path as it is.
        await run(['rev-list', '-z', '--objects', '--stdin'], {
          input,
          signal,
          onRecord: (rec) => {
            if (rec.length === 0) return;
            const text = rec.toString('utf8');
            if (text.startsWith('path=')) {
              const last = found.at(-1);
              if (last) last.path = text.slice('path='.length);
              return;
            }
            if (!OID_PATTERN.test(text)) throw new DtError('GIT_FAILED', 'unexpected rev-list output');
            found.push({ oid: text, path: null });
          },
        });
      } catch (e) {
        // An older development Git: "<oid> <path>" lines. Git cuts a path at a
        // line break there; the review only shows paths, so that is enough.
        if (!(e instanceof DtError) || e.code !== 'GIT_FAILED' || e.details['subcommand'] !== 'rev-list') throw e;
        found = [];
        await run(['rev-list', '--objects', '--stdin'], {
          input,
          signal,
          recordSeparator: 10,
          onRecord: (rec) => {
            const line = rec.toString('utf8');
            if (line === '') return;
            const oid = line.slice(0, 40);
            if (!OID_PATTERN.test(oid)) throw new DtError('GIT_FAILED', 'unexpected rev-list output');
            found.push({ oid, path: line.length > 41 ? line.slice(41) : null });
          },
        });
      }
      if (found.length === 0) return [];
      const r = await run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        input: `${found.map((f) => f.oid).join('\n')}\n`,
        maxOutputBytes: found.length * 80 + 1024,
        timeoutMs: null,
        signal,
      });
      const lines = r.stdout.toString('utf8').split('\n');
      return found.map((f, i): PushObject => {
        const [oid, type, size] = (lines[i] ?? '').split(' ');
        if (oid !== f.oid || (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag')) {
          throw new DtError('GIT_FAILED', 'unexpected cat-file output');
        }
        return { oid: f.oid, type, path: f.path, size: Number(size) };
      });
    },

    async commitsBetween(tip, exclude, signal) {
      const out = await run(['rev-list', '--stdin'], {
        input: revListInput(tip, exclude),
        timeoutMs: null,
        maxOutputBytes: 64 * 1024 * 1024,
        signal,
      });
      return out.stdout
        .toString('utf8')
        .split('\n')
        .filter((l) => OID_PATTERN.test(l));
    },

    async mergeBase(a, b, signal) {
      assertOids([a, b]);
      const out = await run(['merge-base', '--end-of-options', a, b], { okExitCodes: [1], timeoutMs: null, signal });
      const oid = out.stdout.toString('utf8').trim();
      return out.exitCode === 0 && OID_PATTERN.test(oid) ? oid : null;
    },

    async readOrigin() {
      const out = await runGit(
        rt,
        [...HARDENING, 'config', '--file', configFile, '--no-includes', '--get', 'remote.origin.url'],
        root,
        { okExitCodes: [1] },
      );
      if (out.exitCode !== 0) return null;
      const url = out.stdout.toString('utf8').replace(/\n$/, '');
      return url === '' ? null : url;
    },

    async setOrigin(url) {
      const parsed = URL.canParse(url) ? new URL(url) : null;
      const loopback = parsed?.hostname === '127.0.0.1' || parsed?.hostname === 'localhost';
      if (
        /[\n\r\0]/.test(url) ||
        !parsed ||
        !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        throw new DtError('INTERNAL_ERROR', 'invalid origin');
      }
      for (const [key, value] of [
        ['remote.origin.url', url],
        ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ] as const) {
        await runGit(rt, [...HARDENING, 'config', '--file', configFile, '--replace-all', key, value], root);
      }
    },
  };
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
