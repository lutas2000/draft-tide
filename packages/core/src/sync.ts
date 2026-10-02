import {
  BranchName,
  DtError,
  GITHUB_FILE_LIMIT_BYTES,
  GITHUB_FILE_WARNING_BYTES,
  PlanId,
  OperationId,
  canonicalJson,
  readCommitMetadata,
  type Excerpt,
  type GitHubRepo,
  type PushResult,
  type PushReview,
  type RemoteBinding,
  type RemoteConnectPlan,
  type RemoteConnectPlanRecord,
  type RemoteConnectResult,
  type RemoteRelation,
  type RemoteRepoList,
  type RepoRef,
  type SyncError,
  type SyncProgress,
  type SyncState,
  type SyncStatus,
  type ErrorCode,
  type Origin,
  type ProjectId,
} from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import { compareGitPaths } from './paths.ts';
import type { GitAccess, GitOid, ProjectGit, PushObject, RemoteProvider } from './ports.ts';
import { readSmallBlob } from './restore.ts';
import { sha256Hex } from './text.ts';

// Remote sync (M1 plan §10.2–10.3, §10.6): connecting a project to a GitHub
// repository the user created, the first-push review, pushing, and the queue
// that pushes in the background after every save of a connected project.
//
// Saving never waits for any of this. A push writes no working file: only
// objects and refs/remotes/draft-tide/<branch> in the project's `.git`. It
// runs under the project's sync guard (one network operation per project at a
// time), never its write guard, so a slow push never holds up a save.
//
// Fast-forward only: a push never uses `+` or force. When GitHub has commits
// the folder doesn't, the push is REMOTE_DIVERGED and nothing changes on
// either side.

export interface SyncService {
  repos(): Promise<RemoteRepoList>;
  // refresh: ask GitHub now (a failure is recorded in the status, not thrown).
  status(projectId: ProjectId, refresh: boolean): Promise<SyncStatus>;
  connectPlan(projectId: ProjectId, repo: RepoRef): Promise<RemoteConnectPlan>;
  connectApply(projectId: ProjectId, planId: PlanId, setOrigin: boolean): Promise<RemoteConnectResult>;
  disconnect(projectId: ProjectId): Promise<SyncStatus>;
  push(projectId: ProjectId, origin: Origin): Promise<PushResult>;
  // Fetches the connected branch (under the sync guard) and returns the
  // remote's commit, null when GitHub has no such branch. Failures are
  // recorded in the status and thrown.
  fetch(projectId: ProjectId): Promise<GitOid | null>;
  // The branch of a connected project moved (save, restore, recovery): push
  // in the background.
  queue(projectId: ProjectId): void;
  // Someone signed in: pushes waiting for that run now.
  resume(): void;
  // After a pull: the remote's commit is the folder's now.
  recordFetched(projectId: ProjectId, remoteTip: GitOid): void;
  // Engine start and stop.
  start(): void;
  stop(): void;
  // A push is running or due soon: the Engine should stay up.
  busy(): boolean;
}

// Retries after NETWORK_UNAVAILABLE (and other passing failures). AUTH_REQUIRED
// waits for sign-in; REMOTE_DIVERGED and REMOTE_REJECTED wait for the user.
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
// The Engine stays up for a push due within this long.
const KEEP_ALIVE_MS = 2 * 60_000;
// The first-push review's content check: files up to this size, this much in
// all (it is a help, not a promise).
const SECRET_SCAN_FILE_MAX = 1024 * 1024;
const SECRET_SCAN_BUDGET = 64 * 1024 * 1024;
const LARGEST = 10;

// Names that usually hold keys, tokens or credentials.
const SECRET_NAMES: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /(^|\/)\.(npmrc|netrc|pypirc|git-credentials|htpasswd)$/i,
  /(^|\/)[^/]*credentials?[^/]*$/i,
  /(^|\/)[^/]*secrets?\.(json|ya?ml|toml|ini|txt)$/i,
  /(^|\/)service-account[^/]*\.json$/i,
];

// Contents that look like keys or tokens.
const SECRET_CONTENTS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

// Not worth reading for text.
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|sketch|fig|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|pdf|zip|gz|7z|rar)$/i;

const EMPTY: Excerpt = { count: 0, sample: [] };

function excerpt(paths: string[]): Excerpt {
  const sorted = [...new Set(paths)].sort(compareGitPaths);
  return { count: sorted.length, sample: sorted.slice(0, 50) };
}

export function syncErrorOf(e: unknown, at: string): SyncError {
  if (e instanceof DtError) {
    const reason = e.details['reason'];
    return {
      code: e.code,
      reason: typeof reason === 'string' ? reason.slice(0, 64) : null,
      message: e.message.slice(0, 1000),
      at,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    reason: null,
    message: (e instanceof Error ? e.message : String(e)).slice(0, 1000),
    at,
  };
}

export function repoOf(b: RemoteBinding): RepoRef {
  return { owner: b.owner, name: b.name };
}

export function requireProvider(ctx: ProjectContext): RemoteProvider {
  const remote = ctx.remote;
  if (!remote || remote.unavailable !== null) {
    throw new DtError('AUTH_REQUIRED', "this copy of Draft Tide can't sign in to GitHub", { reason: 'unavailable' });
  }
  return remote;
}

// Runs one Git network operation with the user's credential. When Git
// refuses the token (revoked, or rotated by a refresh elsewhere), the
// provider refreshes it if it is still the current one and the operation runs
// once more; a refresh that fails marks the sign-in expired.
export async function withGitAccess<T>(
  ctx: ProjectContext,
  ref: RepoRef,
  fn: (access: GitAccess) => Promise<T>,
): Promise<T> {
  const provider = requireProvider(ctx);
  const access = await provider.gitAccess(ref);
  try {
    return await fn(access);
  } catch (e) {
    if (!(e instanceof DtError) || e.code !== 'AUTH_REQUIRED' || access.credential === null) throw e;
    const again = await provider.gitAccess(ref, undefined, access);
    return fn(again);
  }
}

// How the remote branch relates to the folder's.
export async function relate(
  repo: ProjectGit,
  local: GitOid | null,
  remote: GitOid | null,
): Promise<'same' | 'ahead' | 'behind' | 'diverged' | 'unrelated' | 'empty'> {
  if (remote === null) return 'empty';
  if (local === null) return 'behind';
  if (local === remote) return 'same';
  if (await repo.isAncestor(remote, local)) return 'ahead';
  if (await repo.isAncestor(local, remote)) return 'behind';
  return (await repo.mergeBase(local, remote)) === null ? 'unrelated' : 'diverged';
}

// What a push sends that the remote lacks (M1 plan §10.6).
export async function reviewPush(repo: ProjectGit, tip: GitOid, exclude: readonly GitOid[]): Promise<PushReview> {
  const objects: PushObject[] = await repo.objectsToPush(tip, exclude);
  const commits = objects.filter((o) => o.type === 'commit').map((o) => o.oid);
  let versions = 0;
  for (let i = 0; i < commits.length; i += 200) {
    for (const c of await repo.readCommits(commits.slice(i, i + 200))) {
      if (readCommitMetadata(c.message).status === 'snapshot') versions++;
    }
  }
  const blobs = objects.filter((o) => o.type === 'blob');
  const named = (o: PushObject) => o.path ?? o.oid;
  const largest = [...blobs]
    .sort((a, b) => b.size - a.size)
    .slice(0, LARGEST)
    .map((o) => ({ path: named(o), size: o.size }));
  const suspects = blobs.filter((o) => o.path !== null && SECRET_NAMES.some((re) => re.test(o.path as string)));
  let budget = SECRET_SCAN_BUDGET;
  let complete = true;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const o of blobs) {
    if (suspects.includes(o) || (o.path !== null && BINARY.test(o.path)) || o.size === 0) continue;
    if (o.size > SECRET_SCAN_FILE_MAX || o.size > budget) {
      complete = false;
      continue;
    }
    budget -= o.size;
    const bytes = await readSmallBlob(repo, o.oid, SECRET_SCAN_FILE_MAX);
    if (bytes === null) continue;
    const text = decoder.decode(bytes);
    if (SECRET_CONTENTS.some((re) => re.test(text))) suspects.push(o);
  }
  return {
    commits: commits.length,
    versions,
    files: blobs.length,
    bytes: blobs.reduce((n, o) => n + o.size, 0),
    largest,
    overLimit: excerpt(blobs.filter((o) => o.size > GITHUB_FILE_LIMIT_BYTES).map(named)),
    large: excerpt(
      blobs.filter((o) => o.size > GITHUB_FILE_WARNING_BYTES && o.size <= GITHUB_FILE_LIMIT_BYTES).map(named),
    ),
    suspectedSecrets: suspects.length === 0 ? EMPTY : excerpt(suspects.map(named)),
    secretsScanComplete: complete,
  };
}

// The folder's `remote.origin.url` as shown: credentials removed.
function displayOrigin(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.href.slice(0, 1000);
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//').slice(0, 1000);
  }
}

function sameRepoUrl(origin: string | null, access: GitAccess): boolean {
  if (origin === null) return false;
  const norm = (u: string) =>
    u
      .trim()
      .replace(/\/\/[^@/]*@/, '//')
      .replace(/\.git\/?$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(origin) === norm(access.url);
}

function branchOf(branch: string | null): string {
  const parsed = BranchName.safeParse(branch);
  if (!parsed.success) {
    throw new DtError('INVALID_ARGUMENT', "the folder's branch name can't be synced; use a plain branch name", {
      reason: 'branch-name',
    });
  }
  return parsed.data;
}

export function createSyncService(ctx: ProjectContext): SyncService {
  const { store, clock } = ctx;
  const pushing = new Set<ProjectId>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let ticking = false;

  const changed = (projectId: ProjectId) => ctx.publish({ name: 'remote.changed', projectId });

  function requireRemote(projectId: ProjectId) {
    const stored = store.getRemote(projectId);
    if (!stored) {
      throw new DtError('INVALID_ARGUMENT', 'this project is not connected to a GitHub repository', {
        reason: 'not-connected',
      });
    }
    return stored;
  }

  function stateOf(
    stored: NonNullable<ReturnType<typeof store.getRemote>>,
    ahead: number | null,
    behind: number | null,
    signedIn: boolean,
  ): SyncState {
    if (pushing.has(stored.projectId)) return 'pushing';
    switch (stored.lastError?.code) {
      case 'AUTH_REQUIRED':
        return 'needs-sign-in';
      case 'REMOTE_REJECTED':
        return 'rejected';
      case 'NETWORK_UNAVAILABLE':
        return 'offline';
      case 'REMOTE_DIVERGED':
        return 'diverged';
      default:
        break;
    }
    if ((behind ?? 0) > 0 && (ahead ?? 0) > 0) return 'diverged';
    if ((behind ?? 0) > 0) return 'behind';
    if ((ahead ?? 0) > 0) return signedIn ? 'pending' : 'needs-sign-in';
    return 'synced';
  }

  async function statusOf(projectId: ProjectId): Promise<SyncStatus> {
    const p = ctx.requireProject(projectId);
    const stored = store.getRemote(projectId);
    if (!stored) {
      return {
        projectId,
        remote: null,
        state: 'not-connected',
        localTip: null,
        remoteTip: null,
        ahead: null,
        behind: null,
        lastPushAt: null,
        lastCheckAt: null,
        lastError: null,
        nextAttemptAt: null,
      };
    }
    const branch = stored.remote.branch;
    let localTip: GitOid | null = null;
    let remoteTip = stored.remoteTip;
    let ahead: number | null = null;
    let behind: number | null = null;
    try {
      const { repo } = await ctx.openBound(p);
      localTip = await repo.readRef(`refs/heads/${branch}`);
      remoteTip = (await repo.trackingTip(branch)) ?? remoteTip;
      if (localTip !== null && remoteTip !== null) {
        if (localTip === remoteTip) [ahead, behind] = [0, 0];
        else {
          ahead = (await repo.commitsBetween(localTip, [remoteTip])).length;
          behind = (await repo.commitsBetween(remoteTip, [localTip])).length;
        }
      } else if (localTip !== null && stored.lastCheckAt !== null) {
        ahead = (await repo.commitsBetween(localTip, [])).length;
        behind = 0;
      }
    } catch {
      // The folder or its history is unavailable: what SQLite knows.
    }
    const account = ctx.remote ? await ctx.remote.account() : { state: 'signed-out' as const };
    const queued = store.getQueuedPush(projectId);
    return {
      projectId,
      remote: stored.remote,
      state: stateOf(stored, ahead, behind, account.state === 'signed-in'),
      localTip,
      remoteTip,
      ahead,
      behind,
      lastPushAt: stored.lastPushAt,
      lastCheckAt: stored.lastCheckAt,
      lastError: stored.lastError,
      nextAttemptAt: queued?.nextAttemptAt ?? null,
    };
  }

  // Fetches the remote branch; records what was seen. A refused or failed
  // fetch is recorded and thrown.
  async function fetchRemote(projectId: ProjectId, repo: ProjectGit, b: RemoteBinding, local: GitOid | null) {
    const at = clock.nowIso();
    try {
      const tip = await withGitAccess(ctx, repoOf(b), (access) =>
        repo.fetchBranch(access, b.branch, { haves: local ? [local] : [] }),
      );
      const stored = store.getRemote(projectId);
      const clear =
        stored?.lastError &&
        ['NETWORK_UNAVAILABLE', 'AUTH_REQUIRED', 'REMOTE_DIVERGED'].includes(stored.lastError.code);
      store.updateRemoteState(projectId, { remoteTip: tip, lastCheckAt: at, ...(clear ? { lastError: null } : {}) });
      return { tip };
    } catch (e) {
      store.updateRemoteState(projectId, { lastError: syncErrorOf(e, at) });
      throw e;
    }
  }

  // The push itself, under the sync guard: fetch, refuse anything but a
  // fast-forward, push, record.
  // A push someone is watching (the app's connect, a push now): its progress
  // and its end are reported like a save's. Background pushes report only
  // remote.changed.
  async function reportedPush(
    projectId: ProjectId,
    operation: 'remote.connectApply' | 'sync.push',
    origin: Origin,
  ): Promise<PushResult> {
    const operationId = OperationId.parse(crypto.randomUUID());
    const report = ctx.progressReporter({ operationId, origin, projectId }, operation);
    const settled = (outcome: 'completed' | 'failed', code: ErrorCode | null) =>
      ctx.publish({ name: 'operation.settled', operationId, projectId, operation, origin, outcome, code });
    try {
      const result = await pushProject(projectId, report);
      settled('completed', null);
      return result;
    } catch (e) {
      settled('failed', e instanceof DtError ? e.code : 'INTERNAL_ERROR');
      throw e;
    }
  }

  async function pushProject(projectId: ProjectId, report?: (progress: SyncProgress) => void): Promise<PushResult> {
    return ctx.syncGuards
      .run(projectId, async () => {
        const stored = requireRemote(projectId);
        const b = stored.remote;
        const p = ctx.requireProject(projectId);
        pushing.add(projectId);
        changed(projectId);
        try {
          const { repo } = await ctx.openBound(p);
          const local = await repo.readRef(`refs/heads/${b.branch}`);
          if (local === null) throw new DtError('NO_CHANGES', 'nothing is saved on this branch yet', {});
          report?.({ stage: 'fetch', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
          const { tip: remoteTip } = await fetchRemote(projectId, repo, b, local);
          const relation = await relate(repo, local, remoteTip);
          const at = clock.nowIso();
          if (relation === 'same' || relation === 'behind') {
            store.updateRemoteState(projectId, { lastError: null });
            return { outcome: 'up-to-date' as const, commit: local, commits: 0 };
          }
          if (relation === 'diverged' || relation === 'unrelated') {
            const e = new DtError(
              'REMOTE_DIVERGED',
              'you and GitHub both have new versions; nothing was changed on either side',
              { reason: relation === 'unrelated' ? 'unrelated-history' : 'diverged' },
            );
            store.updateRemoteState(projectId, { lastError: syncErrorOf(e, at) });
            throw e;
          }
          const commits = (await repo.commitsBetween(local, remoteTip ? [remoteTip] : [])).length;
          report?.({ stage: 'push', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
          try {
            await withGitAccess(ctx, repoOf(b), (access) => repo.pushBranch(access, b.branch, local));
          } catch (e) {
            store.updateRemoteState(projectId, { lastError: syncErrorOf(e, clock.nowIso()) });
            throw e;
          }
          const done = clock.nowIso();
          store.updateRemoteState(projectId, {
            remoteTip: local,
            lastPushAt: done,
            lastCheckAt: done,
            lastError: null,
          });
          return { outcome: 'pushed' as const, commit: local, commits };
        } finally {
          pushing.delete(projectId);
          changed(projectId);
        }
      })
      .then(async (r) => {
        // Dequeued first, then the branch read: a save that moved it on
        // either shows here (queued again) or queues itself afterwards. Never
        // a dequeue after a save's request.
        store.dequeuePush(projectId);
        const status = await statusOf(projectId);
        if (status.localTip !== null && status.localTip !== r.commit) store.queuePush(projectId, clock.nowIso());
        schedule();
        return { projectId, ...r, status };
      });
  }

  // ---- The background queue

  function schedule(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const due = store.listQueuedPushes().filter((q) => q.nextAttemptAt !== null);
    if (due.length === 0) return;
    const next = Math.min(...due.map((q) => Date.parse(q.nextAttemptAt as string)));
    const delay = Math.min(Math.max(0, next - Date.now()), 10 * 60_000);
    timer = setTimeout(() => void tick(), delay);
  }

  async function tick(): Promise<void> {
    timer = null;
    if (ticking || stopped) return;
    ticking = true;
    try {
      const now = Date.now();
      for (const q of store.listQueuedPushes()) {
        if (stopped) return;
        if (q.nextAttemptAt === null || Date.parse(q.nextAttemptAt) > now || pushing.has(q.projectId)) continue;
        if (!store.getRemote(q.projectId)) {
          store.dequeuePush(q.projectId);
          continue;
        }
        try {
          await pushProject(q.projectId);
        } catch (e) {
          const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
          if (code === 'NO_CHANGES' || code === 'PROJECT_NOT_BOUND') {
            store.dequeuePush(q.projectId);
            continue;
          }
          const waitForUser = code === 'AUTH_REQUIRED' || code === 'REMOTE_DIVERGED' || code === 'REMOTE_REJECTED';
          const attempts = q.attempts + 1;
          const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] as number;
          store.deferPush(q.projectId, attempts, waitForUser ? null : new Date(Date.now() + delay).toISOString());
          changed(q.projectId);
        }
      }
    } finally {
      ticking = false;
      schedule();
    }
  }

  // ---- Connecting

  async function connectPlan(projectId: ProjectId, ref: RepoRef): Promise<RemoteConnectPlan> {
    const provider = requireProvider(ctx);
    const p = ctx.requireProject(projectId);
    const repoInfo: GitHubRepo = await provider.getRepo(ref, 'push');
    const { repo } = await ctx.openBound(p);
    const probe = await ctx.readableRepo(repo);
    const branch = branchOf(probe.branch);
    const local = probe.tip;
    return ctx.syncGuards.run(projectId, async () => {
      const heads = await withGitAccess(ctx, ref, (access) => repo.remoteHeads(access));
      let remoteTip: GitOid | null = null;
      let relation: RemoteRelation;
      if (heads.size === 0) relation = 'empty';
      else if (!heads.has(`refs/heads/${branch}`)) relation = 'unrelated';
      else {
        // Whatever an earlier connection left in the tracking ref is not
        // this repository's.
        await repo.clearTracking(branch);
        remoteTip = await withGitAccess(ctx, ref, (access) =>
          repo.fetchBranch(access, branch, { haves: local ? [local] : [] }),
        );
        const r = await relate(repo, local, remoteTip);
        relation = r === 'empty' ? 'empty' : r;
      }
      let blocked: RemoteConnectPlan['blocked'] = null;
      if (relation === 'diverged') blocked = { code: 'REMOTE_DIVERGED', reason: 'diverged' };
      else if (relation === 'unrelated') blocked = { code: 'REMOTE_DIVERGED', reason: 'unrelated-history' };
      else if (local === null && relation === 'empty') blocked = { code: 'NO_CHANGES', reason: 'no-versions' };
      const review =
        local !== null && (relation === 'empty' || relation === 'ahead')
          ? await reviewPush(repo, local, remoteTip ? [remoteTip] : [])
          : null;
      if (blocked === null && review && review.overLimit.count > 0) {
        blocked = { code: 'REMOTE_REJECTED', reason: 'file-too-large' };
      }
      const origin = await repo.readOrigin();
      const record: RemoteConnectPlanRecord = {
        kind: 'remote-connect',
        repo: repoInfo,
        branch,
        localTip: local,
        remoteTip,
      };
      const fingerprint = await sha256Hex(canonicalJson({ repo: repoInfo.id, branch, local, remoteTip }));
      const createdAt = clock.nowIso();
      const planId = PlanId.parse(crypto.randomUUID());
      const expiresAt = new Date(Date.parse(createdAt) + ctx.planTtlMs).toISOString();
      store.insertPlan({ planId, projectId, createdAt, expiresAt, fingerprint, record, consumedBy: null });
      return {
        planId,
        projectId,
        createdAt,
        expiresAt,
        repo: repoInfo,
        branch,
        relation,
        localTip: local,
        remoteTip,
        review,
        origin: { url: displayOrigin(origin), matches: sameRepoUrl(origin, await provider.gitAccess(ref)) },
        blocked,
      };
    });
  }

  async function connectApply(projectId: ProjectId, planId: PlanId, setOrigin: boolean): Promise<RemoteConnectResult> {
    const provider = requireProvider(ctx);
    const p = ctx.requireProject(projectId);
    const plan = store.getPlan(planId);
    if (!plan || plan.record.kind !== 'remote-connect') {
      throw new DtError('INVALID_ARGUMENT', 'no connect plan has this id', { reason: 'unknown-plan' });
    }
    if (plan.projectId !== projectId) {
      throw new DtError('INVALID_ARGUMENT', 'this plan belongs to another project', {
        reason: 'plan-of-another-project',
      });
    }
    if (plan.consumedBy !== null)
      throw new DtError('PLAN_STALE', 'this plan was already applied; make a new one', { reason: 'used' });
    if (Date.parse(clock.nowIso()) > Date.parse(plan.expiresAt)) {
      throw new DtError('PLAN_STALE', 'this plan has expired; check the repository again', { reason: 'expired' });
    }
    const record = plan.record;
    if (!store.consumePlan(planId, OperationId.parse(crypto.randomUUID()), clock.nowIso())) {
      throw new DtError('PLAN_STALE', 'this plan was already applied; make a new one', { reason: 'used' });
    }
    const repoInfo = await provider.getRepo({ owner: record.repo.owner, name: record.repo.name }, 'push');
    if (repoInfo.id !== record.repo.id) {
      throw new DtError('PLAN_STALE', 'this repository changed since it was checked; check it again', {
        reason: 'changed',
      });
    }
    const { repo } = await ctx.openBound(p);
    const binding: RemoteBinding = {
      provider: 'github',
      repoId: repoInfo.id,
      owner: repoInfo.owner,
      name: repoInfo.name,
      visibility: repoInfo.visibility,
      branch: record.branch,
      connectedAt: clock.nowIso(),
    };
    let originSet = false;
    await ctx.syncGuards.run(projectId, async () => {
      const probe = await ctx.readableRepo(repo);
      if (probe.branch !== record.branch || probe.tip !== record.localTip) {
        throw new DtError('PLAN_STALE', 'new versions were saved since the check; check again', {
          reason: 'history-changed',
        });
      }
      // Another repository may have been connected before: its tip is not
      // this one's.
      await repo.clearTracking(record.branch);
      if (record.localTip === null && record.remoteTip === null) {
        throw new DtError('NO_CHANGES', 'save a version before connecting a repository', { reason: 'no-versions' });
      }
      const remoteTip = await withGitAccess(ctx, binding, (access) =>
        repo.fetchBranch(access, record.branch, { haves: record.localTip ? [record.localTip] : [] }),
      );
      if (remoteTip !== record.remoteTip) {
        throw new DtError('PLAN_STALE', 'the repository changed since it was checked; check it again', {
          reason: 'changed',
        });
      }
      const relation = await relate(repo, record.localTip, remoteTip);
      if (relation === 'diverged' || relation === 'unrelated') {
        throw new DtError(
          'REMOTE_DIVERGED',
          "this repository holds a history the folder doesn't share; use an empty repository",
          {
            reason: relation === 'unrelated' ? 'unrelated-history' : 'diverged',
          },
        );
      }
      store.putRemote(projectId, binding);
      store.updateRemoteState(projectId, { remoteTip, lastCheckAt: clock.nowIso() });
      if (setOrigin) {
        await repo.setOrigin((await provider.gitAccess(binding)).url);
        originSet = true;
      }
    });
    changed(projectId);
    // The first push. Its failure doesn't undo the connection: the status
    // says what happened, and the queue tries again where that helps.
    let push: PushResult | null = null;
    const status = await statusOf(projectId);
    if ((status.ahead ?? 0) > 0) {
      store.queuePush(projectId, clock.nowIso());
      try {
        push = await reportedPush(projectId, 'remote.connectApply', 'gui');
      } catch (e) {
        const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
        const waitForUser = code === 'AUTH_REQUIRED' || code === 'REMOTE_DIVERGED' || code === 'REMOTE_REJECTED';
        store.deferPush(
          projectId,
          1,
          waitForUser ? null : new Date(Date.now() + (BACKOFF_MS[0] as number)).toISOString(),
        );
        schedule();
      }
    }
    return { projectId, remote: binding, originSet, push, status: await statusOf(projectId) };
  }

  return {
    repos: () => requireProvider(ctx).listRepos(),

    async status(projectId, refresh) {
      if (refresh && store.getRemote(projectId)) {
        const stored = requireRemote(projectId);
        const p = ctx.requireProject(projectId);
        await ctx.syncGuards
          .run(projectId, async () => {
            const { repo } = await ctx.openBound(p);
            const local = await repo.readRef(`refs/heads/${stored.remote.branch}`);
            await fetchRemote(projectId, repo, stored.remote, local);
          })
          .catch(() => undefined);
        changed(projectId);
      }
      return statusOf(projectId);
    },

    connectPlan,
    connectApply,

    async disconnect(projectId) {
      ctx.requireProject(projectId);
      await ctx.syncGuards.run(projectId, async () => {
        const stored = store.getRemote(projectId);
        store.deleteRemote(projectId);
        if (stored) {
          const p = ctx.requireProject(projectId);
          await ctx
            .openBound(p)
            .then(({ repo }) => repo.clearTracking(stored.remote.branch))
            .catch(() => undefined);
        }
      });
      changed(projectId);
      return statusOf(projectId);
    },

    async push(projectId, origin) {
      requireRemote(projectId);
      store.queuePush(projectId, clock.nowIso());
      try {
        return await reportedPush(projectId, 'sync.push', origin);
      } catch (e) {
        const code = e instanceof DtError ? e.code : 'INTERNAL_ERROR';
        const waitForUser = code === 'AUTH_REQUIRED' || code === 'REMOTE_DIVERGED' || code === 'REMOTE_REJECTED';
        if (code === 'NO_CHANGES') store.dequeuePush(projectId);
        else
          store.deferPush(
            projectId,
            1,
            waitForUser ? null : new Date(Date.now() + (BACKOFF_MS[0] as number)).toISOString(),
          );
        schedule();
        throw e;
      }
    },

    async fetch(projectId) {
      const stored = requireRemote(projectId);
      const p = ctx.requireProject(projectId);
      try {
        return await ctx.syncGuards.run(projectId, async () => {
          const { repo } = await ctx.openBound(p);
          const local = await repo.readRef(`refs/heads/${stored.remote.branch}`);
          return (await fetchRemote(projectId, repo, stored.remote, local)).tip;
        });
      } finally {
        changed(projectId);
      }
    },

    queue(projectId) {
      if (!store.getRemote(projectId)) return;
      store.queuePush(projectId, clock.nowIso());
      changed(projectId);
      schedule();
    },

    resume() {
      const now = clock.nowIso();
      for (const q of store.listQueuedPushes()) store.deferPush(q.projectId, q.attempts, now);
      schedule();
    },

    recordFetched(projectId, remoteTip) {
      if (!store.getRemote(projectId)) return;
      store.updateRemoteState(projectId, { remoteTip, lastCheckAt: clock.nowIso(), lastError: null });
      store.dequeuePush(projectId);
      changed(projectId);
    },

    start() {
      stopped = false;
      schedule();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    busy() {
      if (pushing.size > 0 || ticking) return true;
      const soon = Date.now() + KEEP_ALIVE_MS;
      return store.listQueuedPushes().some((q) => q.nextAttemptAt !== null && Date.parse(q.nextAttemptAt) <= soon);
    },
  };
}
