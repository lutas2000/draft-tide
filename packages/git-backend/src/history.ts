import { constants } from 'node:fs';
import { lstat, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  CommitIdentity,
  DtError,
  IsoTimestamp,
  OperationId,
  isSafeRelativePath,
  isSingleLine,
  type JsonValue,
} from '@draft-tide/contracts';
import {
  compareGitPaths,
  type GitCommit,
  type GitHistory,
  type GitListing,
  type GitOid,
  type GitPerson,
  type GitTreeEntry,
  type IndexLockState,
  type PublishRequest,
  type TreeEntryInput,
} from '@draft-tide/core';
import { runGit, type GitOutput, type RunOptions } from './process.ts';
import { isBranchRef, readBranchTip } from './probe.ts';
import { HARDENING, type GitRuntime } from './runtime.ts';

// Writing a version into the project's own repo and reading history back
// (M1 plan §6.1, §7.1 steps 6–8, §9.3.1). Plumbing only: hash-object
// --no-filters, a temporary index (update-index --index-info, read-tree,
// write-tree), commit-tree, update-ref with the expected old id, and cat-file,
// ls-tree, rev-list and merge-base to read. Nothing here runs a hook, a filter
// or a configured program (HARDENING), and nothing touches working files.

export const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
const LOCK_MARKER = /^draft-tide ([0-9a-f-]{36})\n$/;
const DEFAULT_LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 25;
// Commit objects are kept up to this size (headers and message); the rest of
// a larger one is dropped and the commit marked truncated.
export const MAX_COMMIT_BYTES = 1024 * 1024;
const MAX_HISTORY_PAGE = 10_000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface HistoryTestHooks {
  // Runs between the ref update and the index switch (§9.3.1 steps 3 and 4).
  // Throwing leaves the repo as a crash at that point would.
  afterRefUpdate?: (operationId: OperationId) => Promise<void> | void;
}

type Run = (args: string[], options?: RunOptions) => Promise<GitOutput>;
type Stream = (args: string[], signal?: AbortSignal) => AsyncGenerator<Buffer, void, undefined>;

function assertOid(oid: string): void {
  if (!OID.test(oid)) throw new DtError('INTERNAL_ERROR', 'invalid object id');
}

function assertOperationId(id: string): void {
  if (!OperationId.safeParse(id).success) throw new DtError('INTERNAL_ERROR', 'invalid operation id');
}

function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

// A filesystem failure inside `.git`, classified like the adapters do:
// running out of space is INSUFFICIENT_DISK_SPACE wherever it happens.
function fsError(e: unknown, what: string): DtError {
  if (e instanceof DtError) return e;
  const code = errnoOf(e);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new DtError('INSUFFICIENT_DISK_SPACE', 'the disk ran out of space; nothing was saved', {
      volume: 'project',
    });
  }
  return new DtError('STORAGE_IO_FAILED', `${what} failed${code ? ` (${code})` : ''}`, code ? { errno: code } : {});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return false;
    throw fsError(e, 'checking the repository');
  }
}

// Atomic within one directory. Windows refuses to replace a file another
// process has open (an editor's `git status` reading the index), briefly.
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = errnoOf(e);
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (process.platform !== 'win32' || !transient || attempt >= 40) throw e;
      await sleep(LOCK_POLL_MS);
    }
  }
}

export function createHistory(args: {
  rt: GitRuntime;
  root: string;
  gitDir: string;
  run: Run;
  stream: Stream;
  hooks?: HistoryTestHooks | undefined;
}): GitHistory {
  const { rt, root, gitDir, run, stream, hooks } = args;
  const indexPath = join(gitDir, 'index');
  const lockPath = join(gitDir, 'index.lock');
  // Next to the real index, so the final rename stays on one volume.
  const preparedIndex = (operationId: string) => {
    assertOperationId(operationId);
    return join(gitDir, `index.dt-${operationId}`);
  };

  async function discardPreparedIndex(operationId: OperationId): Promise<void> {
    const path = preparedIndex(operationId);
    // Git's own lock for writing it, should a write have been cut short.
    for (const p of [path, `${path}.lock`]) await rm(p, { force: true });
  }

  async function readIndexLock(): Promise<IndexLockState> {
    let fh: FileHandle;
    try {
      fh = await open(lockPath, constants.O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return { held: false };
      if (errnoOf(e) === 'ELOOP') return { held: true, by: 'other' };
      throw fsError(e, 'reading the index lock');
    }
    try {
      const st = await fh.stat();
      const buf = Buffer.alloc(64);
      const { bytesRead } = st.isFile() ? await fh.read(buf, 0, buf.length, 0) : { bytesRead: 0 };
      const m = bytesRead === st.size ? LOCK_MARKER.exec(buf.subarray(0, bytesRead).toString('latin1')) : null;
      const id = m ? OperationId.safeParse(m[1]) : null;
      return id?.success ? { held: true, by: 'draft-tide', operationId: id.data } : { held: true, by: 'other' };
    } finally {
      await fh.close();
    }
  }

  // Git's own lock: created exclusively, so another Git that holds it makes
  // this wait and then fail, and while it is held any other Git that would
  // write the index fails loudly instead of racing. The content names the
  // operation, so recovery can tell the lock is Draft Tide's.
  async function acquireIndexLock(operationId: OperationId, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let fh: FileHandle;
      try {
        fh = await open(lockPath, 'wx', 0o644);
      } catch (e) {
        if (errnoOf(e) !== 'EEXIST') throw fsError(e, 'locking the index');
        if (Date.now() >= deadline) {
          throw new DtError(
            'LOCKED',
            'another Git program is using this repository right now; nothing was changed, try again in a moment',
            { lock: 'index' },
          );
        }
        await sleep(LOCK_POLL_MS);
        continue;
      }
      try {
        await fh.writeFile(`draft-tide ${operationId}\n`);
        await fh.sync();
        await fh.close();
      } catch (e) {
        await fh.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw fsError(e, 'locking the index');
      }
      return;
    }
  }

  async function releaseIndexLock(operationId: OperationId): Promise<void> {
    assertOperationId(operationId);
    const state = await readIndexLock();
    if (!state.held || state.by !== 'draft-tide' || state.operationId !== operationId) return;
    try {
      await unlink(lockPath);
    } catch (e) {
      if (errnoOf(e) !== 'ENOENT') throw fsError(e, 'releasing the index lock');
    }
  }

  // Why update-ref failed, from the repo's state rather than Git's wording.
  // now: the branch tip read afterwards (undefined if that failed too).
  async function refUpdateFailure(
    e: unknown,
    ref: string,
    expectedOld: GitOid | null,
    now: GitOid | null | undefined,
  ): Promise<unknown> {
    if (!(e instanceof DtError) || e.code !== 'GIT_FAILED') return e;
    if (now !== undefined && now !== expectedOld) {
      return new DtError(
        'HISTORY_CHANGED',
        'another program added to the history while saving; nothing was overwritten, save again to build on it',
        {},
      );
    }
    if (await exists(join(gitDir, ...ref.split('/')) + '.lock').catch(() => false)) {
      return new DtError(
        'LOCKED',
        'another Git program is updating this branch right now; nothing was changed, try again in a moment',
        { lock: 'ref' },
      );
    }
    return e;
  }

  async function verifyPreparedIndex(
    env: Record<string, string>,
    entries: readonly TreeEntryInput[],
    signal?: AbortSignal,
  ): Promise<void> {
    const listed = new Map<string, { mode: string; oid: string; stage: string }>();
    let extra = 0;
    await run(['ls-files', '--stage', '-z'], {
      env,
      signal,
      onRecord: (rec) => {
        if (rec.length === 0) return;
        const tab = rec.indexOf(9);
        const m = /^(\d{6}) ([0-9a-f]{40}) (\d)$/.exec(rec.subarray(0, tab).toString('latin1'));
        if (tab < 0 || !m) throw new DtError('GIT_FAILED', 'unexpected ls-files output');
        const path = rec.subarray(tab + 1).toString('utf8');
        if (listed.has(path)) extra++;
        listed.set(path, { mode: m[1] as string, oid: m[2] as string, stage: m[3] as string });
      },
    });
    // update-index skips a path it refuses with only a message on stderr and
    // exit code 0. A version must never silently lose a file.
    const dropped = entries.filter((e) => !listed.has(e.path)).map((e) => e.path);
    if (dropped.length > 0) {
      dropped.sort(compareGitPaths);
      throw new DtError('UNSUPPORTED_ENTRY', 'Git refuses some names in the folder; rename them first', {
        count: dropped.length,
        entries: dropped.slice(0, 50).map((path) => ({ path, kind: 'invalid-name' })),
      });
    }
    const mismatch = entries.some((e) => {
      const l = listed.get(e.path);
      return l?.mode !== e.mode || l.oid !== e.oid || l.stage !== '0';
    });
    if (mismatch || extra > 0 || listed.size !== entries.length) {
      throw new DtError('GIT_FAILED', 'the prepared index does not hold exactly the version being saved');
    }
  }

  async function readCommits(oids: readonly GitOid[], signal?: AbortSignal): Promise<GitCommit[]> {
    if (oids.length === 0) return [];
    oids.forEach(assertOid);
    const reader = new BatchReader(MAX_COMMIT_BYTES);
    await run(['cat-file', '--batch=%(objectname) %(objecttype) %(objectsize)'], {
      input: `${oids.join('\n')}\n`,
      onChunk: (chunk) => reader.push(chunk),
      signal,
    });
    reader.end();
    if (reader.objects.length !== oids.length) throw new DtError('GIT_FAILED', 'cat-file returned too few objects');
    return reader.objects.map((o) => {
      if (o.type === 'missing') throw new DtError('GIT_FAILED', 'a commit is missing from the repository');
      if (o.type !== 'commit') throw new DtError('GIT_FAILED', 'not a commit');
      return parseCommit(o.oid, o.data, o.truncated);
    });
  }

  return {
    async init(signal) {
      if (await exists(join(root, '.git'))) throw new DtError('INTERNAL_ERROR', 'the folder already has a .git');
      // Explicit formats: Git 3 changes the defaults to ones Draft Tide refuses
      // (sha256, reftable). No template: no hooks, no sample files.
      await runGit(
        rt,
        [
          ...HARDENING,
          'init',
          '--quiet',
          '--template=',
          '--initial-branch=main',
          '--object-format=sha1',
          '--ref-format=files',
          '--',
          root,
        ],
        root,
        { signal },
      );
    },

    async writeBlobs(files, onWritten, signal) {
      if (files.length === 0) return [];
      // One absolute path per line on stdin (a relative one would be read
      // from the working folder); staging paths never contain a line break.
      if (files.some((f) => /[\n\r]/.test(f) || !isAbsolute(f))) {
        throw new DtError('INTERNAL_ERROR', 'unusable staged path');
      }
      const oids: GitOid[] = [];
      await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
        input: `${files.join('\n')}\n`,
        recordSeparator: 10,
        timeoutMs: null,
        signal,
        onRecord: (rec) => {
          const oid = rec.toString('latin1');
          if (!OID.test(oid)) throw new DtError('GIT_FAILED', 'unexpected hash-object output');
          oids.push(oid);
          onWritten?.(oids.length - 1);
        },
      });
      if (oids.length !== files.length)
        throw new DtError('GIT_FAILED', 'hash-object wrote a different number of objects');
      return oids;
    },

    async prepareIndex(operationId, entries, signal) {
      const index = preparedIndex(operationId);
      const paths = new Set<string>();
      for (const e of entries) {
        // Capture refuses all of these first; this is the backstop.
        if (!isSafeRelativePath(e.path) || paths.has(e.path)) {
          throw new DtError('INTERNAL_ERROR', 'a version entry has an unusable or repeated path');
        }
        if (e.mode !== '100644' && e.mode !== '100755') throw new DtError('INTERNAL_ERROR', 'unsupported mode');
        assertOid(e.oid);
        paths.add(e.path);
      }
      const env = { GIT_INDEX_FILE: index };
      // It must start empty: update-index adds to whatever is there.
      await discardPreparedIndex(operationId);
      try {
        await run(['update-index', '--add', '-z', '--index-info'], {
          input: entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(''),
          env,
          timeoutMs: null,
          signal,
        });
        await verifyPreparedIndex(env, entries, signal);
        // Refuses an entry whose object is missing: a version never depends
        // on content that isn't in the object store.
        const tree = (await run(['write-tree'], { env, timeoutMs: null, signal })).stdout.toString('latin1').trim();
        if (!OID.test(tree)) throw new DtError('GIT_FAILED', 'unexpected write-tree output');
        return tree;
      } catch (e) {
        await discardPreparedIndex(operationId);
        throw e;
      }
    },

    async prepareIndexFromTree(operationId, tree, signal) {
      const index = preparedIndex(operationId);
      assertOid(tree);
      await discardPreparedIndex(operationId);
      try {
        await run(['read-tree', '--end-of-options', tree], { env: { GIT_INDEX_FILE: index }, timeoutMs: null, signal });
      } catch (e) {
        await discardPreparedIndex(operationId);
        throw e;
      }
    },

    discardPreparedIndex,

    async createCommit({ tree, parents, message, identity, time }, signal) {
      assertOid(tree);
      parents.forEach(assertOid);
      if (new Set(parents).size !== parents.length) throw new DtError('INTERNAL_ERROR', 'repeated parent');
      const who = CommitIdentity.safeParse(identity);
      if (!who.success) throw new DtError('INTERNAL_ERROR', 'commit identity outside its contract');
      if (!IsoTimestamp.safeParse(time).success) throw new DtError('INTERNAL_ERROR', 'invalid commit time');
      if (message.includes('\0')) throw new DtError('INTERNAL_ERROR', 'invalid commit message');
      // Git's raw date format; UTC, so no local offset ends up in history.
      const date = `@${Math.floor(Date.parse(time) / 1000)} +0000`;
      const out = await run(
        ['commit-tree', '--no-gpg-sign', ...parents.flatMap((p) => ['-p', p]), '--end-of-options', tree],
        {
          input: message,
          signal,
          env: {
            GIT_AUTHOR_NAME: who.data.name,
            GIT_AUTHOR_EMAIL: who.data.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: who.data.name,
            GIT_COMMITTER_EMAIL: who.data.email,
            GIT_COMMITTER_DATE: date,
          },
        },
      );
      const oid = out.stdout.toString('latin1').trim();
      if (!OID.test(oid)) throw new DtError('GIT_FAILED', 'unexpected commit-tree output');
      return oid;
    },

    // M1 plan §9.3.1. Moving the ref first would leave a stale index in which
    // anyone's plain `git commit` silently commits the old tree on top of the
    // new version (measured in the single-repo spike), hence lock first.
    async publish(request: PublishRequest) {
      const { operationId, ref, expectedOld, commit, reflogMessage } = request;
      const index = preparedIndex(operationId);
      if (!isBranchRef(ref)) throw new DtError('INTERNAL_ERROR', 'not a branch ref');
      assertOid(commit);
      if (expectedOld !== null) assertOid(expectedOld);
      if (!isSingleLine(reflogMessage) || reflogMessage.length > 200) {
        throw new DtError('INTERNAL_ERROR', 'invalid reflog message');
      }
      if (!(await exists(index))) throw new DtError('INTERNAL_ERROR', 'no prepared index for this operation');
      try {
        // The index that goes in must describe the commit's tree, or the
        // switch would install exactly the stale index it exists to prevent.
        const [target] = await readCommits([commit]);
        const indexTree = (await run(['write-tree'], { env: { GIT_INDEX_FILE: index } })).stdout
          .toString('latin1')
          .trim();
        if (target?.tree !== indexTree) {
          throw new DtError('INTERNAL_ERROR', "the prepared index does not match the commit's tree");
        }
        // 1. The lock. Held by another Git: nothing has changed yet.
        await acquireIndexLock(operationId, request.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
      } catch (e) {
        await discardPreparedIndex(operationId);
        throw e;
      }
      // 2. Compare-and-swap. Lost: someone committed meanwhile; nothing was
      // overwritten, and a new save builds on their commit.
      try {
        await run(['update-ref', '-m', reflogMessage, ref, commit, expectedOld ?? ZERO_OID]);
      } catch (e) {
        const now = await readBranchTip(run, ref).catch(() => undefined);
        // Git reported a failure after moving the ref: the version is in
        // history, and releasing the lock now would leave a stale index.
        if (now !== commit) {
          const failure = await refUpdateFailure(e, ref, expectedOld, now);
          await unlink(lockPath).catch(() => undefined);
          await discardPreparedIndex(operationId);
          throw failure;
        }
      }
      // 3. The index, then 4. the lock. From here on the version is in
      // history; a failure leaves the lock in place so no other Git can
      // commit the old index, and recovery finishes the switch.
      try {
        await hooks?.afterRefUpdate?.(operationId);
        await renameOver(index, indexPath);
        await unlink(lockPath);
      } catch (e) {
        const details: Record<string, JsonValue> = { operationId, commit };
        const code = errnoOf(e);
        if (code) details['errno'] = code;
        throw new DtError(
          'RECOVERY_REQUIRED',
          "the version was saved, but switching Git's index to it did not finish; it is completed before the next change",
          details,
        );
      }
    },

    async finishPublish(operationId) {
      const index = preparedIndex(operationId);
      const state = await readIndexLock();
      if (state.held && (state.by !== 'draft-tide' || state.operationId !== operationId)) {
        throw new DtError('LOCKED', 'another Git program is using this repository right now; try again in a moment', {
          lock: 'index',
        });
      }
      // Someone removed the lock by hand: take it again before touching the
      // index.
      if (!state.held) await acquireIndexLock(operationId, DEFAULT_LOCK_WAIT_MS);
      try {
        if (await exists(index)) await renameOver(index, indexPath);
        await unlink(lockPath);
      } catch (e) {
        throw fsError(e, "finishing the switch of Git's index");
      }
    },

    indexLock: readIndexLock,
    releaseIndexLock,

    readRef(ref, signal) {
      return readBranchTip(run, ref, signal);
    },

    readCommits,

    async firstParentLine(tip, page, signal) {
      assertOid(tip);
      const { skip, limit } = page;
      if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new DtError('INTERNAL_ERROR', 'invalid history page');
      }
      const count = Math.min(limit, MAX_HISTORY_PAGE);
      const out = await run(
        ['rev-list', '--first-parent', `--skip=${skip}`, `--max-count=${count}`, '--end-of-options', tip],
        { maxOutputBytes: count * 41 + 1024, timeoutMs: null, signal },
      );
      const oids = out.stdout.toString('latin1').split('\n').filter(Boolean);
      if (!oids.every((o) => OID.test(o))) throw new DtError('GIT_FAILED', 'unexpected rev-list output');
      return oids;
    },

    async listTree(treeish, signal) {
      assertOid(treeish);
      const entries: GitTreeEntry[] = [];
      const nonUtf8: string[] = [];
      await run(['ls-tree', '-r', '-z', '-l', '--full-tree', '--end-of-options', treeish], {
        signal,
        onRecord: (rec) => {
          if (rec.length === 0) return;
          const entry = parseTreeRecord(rec);
          if ('invalid' in entry) {
            nonUtf8.push(entry.invalid);
            return;
          }
          const { type } = entry;
          // -r lists files and gitlinks, never the trees themselves.
          if (type === 'tree') throw new DtError('GIT_FAILED', 'unexpected ls-tree output');
          entries.push({ ...entry, type });
        },
      });
      return { entries, nonUtf8 } satisfies GitListing<GitTreeEntry>;
    },

    async lookupPath(tree, path, signal) {
      assertOid(tree);
      if (!isSafeRelativePath(path)) throw new DtError('INTERNAL_ERROR', 'not a path inside the project');
      const found: GitTreeEntry[] = [];
      // Pathspecs are literal (HARDENING). A folder of that name is not a file.
      await run(['ls-tree', '-z', '-l', '--full-tree', '--end-of-options', tree, path], {
        signal,
        onRecord: (rec) => {
          if (rec.length === 0) return;
          const entry = parseTreeRecord(rec);
          if ('invalid' in entry || entry.path !== path) return;
          const { type } = entry;
          if (type !== 'tree') found.push({ ...entry, type });
        },
      });
      return found[0] ?? null;
    },

    async *streamBlob(oid, signal) {
      assertOid(oid);
      yield* stream(['cat-file', 'blob', '--end-of-options', oid], signal);
    },

    async isAncestor(ancestor, descendant, signal) {
      assertOid(ancestor);
      assertOid(descendant);
      const r = await run(['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant], {
        okExitCodes: [1],
        timeoutMs: null,
        signal,
      });
      return r.exitCode === 0;
    },
  };
}

// ---- Parsing

const lossyUtf8 = new TextDecoder('utf-8');
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

type TreeRecord = Omit<GitTreeEntry, 'type'> & { type: GitTreeEntry['type'] | 'tree' };

// "<mode> SP <type> SP <oid> SP+ <size or ->\t<path>"
function parseTreeRecord(rec: Buffer): TreeRecord | { invalid: string } {
  const tab = rec.indexOf(9);
  const m = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40}) +(-|\d+)$/.exec(rec.subarray(0, tab).toString('latin1'));
  if (tab < 0 || !m) throw new DtError('GIT_FAILED', 'unexpected ls-tree output');
  const raw = rec.subarray(tab + 1);
  let path: string;
  try {
    path = strictUtf8.decode(raw);
  } catch {
    return { invalid: lossyUtf8.decode(raw) };
  }
  const [, mode = '', type = '', oid = '', size = '-'] = m;
  return {
    path,
    mode,
    type: type as 'blob' | 'commit' | 'tree',
    oid,
    size: size === '-' ? null : Number(size),
  };
}

// "Name <email> 1700000000 +0800". Other tools write odd identities; they are
// shown as they are rather than failing the whole history.
function parsePerson(value: string): GitPerson {
  const m = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!m) return { name: value, email: '', time: 0, offset: '+0000' };
  const time = Number(m[3]);
  return {
    name: m[1] as string,
    email: m[2] as string,
    time: Number.isSafeInteger(time) ? time : 0,
    offset: m[4] as string,
  };
}

function parseCommit(oid: GitOid, raw: Buffer, truncated: boolean): GitCommit {
  const sep = raw.indexOf('\n\n');
  if (sep < 0 && truncated) throw new DtError('GIT_FAILED', 'a commit is too large to read');
  const header = (sep < 0 ? raw : raw.subarray(0, sep)).toString('utf8');
  const message = sep < 0 ? '' : lossyUtf8.decode(raw.subarray(sep + 2));
  let tree: string | null = null;
  const parents: string[] = [];
  let author: GitPerson | null = null;
  let committer: GitPerson | null = null;
  for (const line of header.split('\n')) {
    // Continuation lines of multi-line headers (gpgsig, mergetag).
    if (line.startsWith(' ')) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree' && tree === null) tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author' && author === null) author = parsePerson(value);
    else if (key === 'committer' && committer === null) committer = parsePerson(value);
  }
  if (tree === null || !OID.test(tree) || !parents.every((p) => OID.test(p)) || !author || !committer) {
    throw new DtError('GIT_FAILED', 'a commit could not be read');
  }
  return { oid, tree, parents, author, committer, message, truncated };
}

interface BatchObject {
  oid: string;
  type: string;
  data: Buffer;
  truncated: boolean;
}

// `cat-file --batch=<oid> <type> <size>` output: a header line, exactly size
// bytes of content, a newline; or "<oid> missing". Content past `keep` bytes
// is counted but dropped, so one huge object can't exhaust memory.
class BatchReader {
  readonly objects: BatchObject[] = [];
  readonly #keep: number;
  #pending: Buffer = Buffer.alloc(0);
  #current: { oid: string; type: string; remaining: number; parts: Buffer[]; kept: number; truncated: boolean } | null =
    null;
  #needNewline = false;

  constructor(keep: number) {
    this.#keep = keep;
  }

  push(chunk: Buffer): void {
    let buf = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    for (;;) {
      if (this.#needNewline) {
        if (buf.length === 0) break;
        if (buf[0] !== 10) throw new DtError('GIT_FAILED', 'unexpected cat-file output');
        buf = buf.subarray(1);
        this.#needNewline = false;
      }
      const cur = this.#current;
      if (cur) {
        const take = Math.min(cur.remaining, buf.length);
        const room = Math.max(0, this.#keep - cur.kept);
        if (room > 0) cur.parts.push(Buffer.from(buf.subarray(0, Math.min(take, room))));
        if (take > room) cur.truncated = true;
        cur.kept += Math.min(take, room);
        cur.remaining -= take;
        buf = buf.subarray(take);
        if (cur.remaining > 0) break;
        this.objects.push({ oid: cur.oid, type: cur.type, data: Buffer.concat(cur.parts), truncated: cur.truncated });
        this.#current = null;
        this.#needNewline = true;
        continue;
      }
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > 1024) throw new DtError('GIT_FAILED', 'unexpected cat-file output');
        break;
      }
      const line = buf.subarray(0, nl).toString('latin1');
      buf = buf.subarray(nl + 1);
      const missing = /^(\S+) missing$/.exec(line);
      if (missing) {
        this.objects.push({ oid: missing[1] as string, type: 'missing', data: Buffer.alloc(0), truncated: false });
        continue;
      }
      const m = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(line);
      if (!m) throw new DtError('GIT_FAILED', 'unexpected cat-file output');
      this.#current = {
        oid: m[1] as string,
        type: m[2] as string,
        remaining: Number(m[3]),
        parts: [],
        kept: 0,
        truncated: false,
      };
      if (this.#current.remaining === 0) {
        this.objects.push({ oid: m[1] as string, type: m[2] as string, data: Buffer.alloc(0), truncated: false });
        this.#current = null;
        this.#needNewline = true;
      }
    }
    this.#pending = Buffer.from(buf);
  }

  end(): void {
    if (this.#current || this.#needNewline || this.#pending.length > 0) {
      throw new DtError('GIT_FAILED', 'cat-file output ended early');
    }
  }
}
