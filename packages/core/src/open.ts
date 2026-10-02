import { sep } from 'node:path';
import {
  BranchName,
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  OperationId,
  PROJECT_CONFIG_FILE,
  PlanId,
  canonicalJson,
  parseProjectConfig,
  readCommitMetadata,
  type ErrorCode,
  type GitHubRepo,
  type OpenJournal,
  type OpenPlanRecord,
  type Origin,
  type ProjectConfig,
  type ProjectSummary,
  type RemoteBinding,
  type RemoteOpenPlan,
  type RemoteOpenResult,
  type RepoRef,
  type SyncProgress,
} from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import { operationError } from './journal.ts';
import type { GitOid, OperationFile, OperationRecord } from './ports.ts';
import { BINDINGS_GUARD } from './projects.ts';
import { recordFastForward } from './pull.ts';
import { accessCheck, fileStates, readSmallBlob, restorableFiles, stale, transition, usablePlan } from './restore.ts';
import { SPACE_MARGIN_BYTES } from './capture.ts';
import { requireProvider, withGitAccess } from './sync.ts';
import { sha256Hex } from './text.ts';

// Opening a project from GitHub (M1 plan §10.7), the way back after a lost
// folder and the way onto another computer.
//
// plan   checks the repository and the destination, which must not exist yet
//        (its parent must) or be an empty folder, and reads the remote
//        branch's commit. Nothing is written.
// apply  creates the folder if needed, `git init`s it (the remote's branch),
//        fetches, checks the newest version's `.drafttide.json` (untrusted
//        input: strict schema), connects the project and its remote, journals
//        an `open`, writes every file expecting nothing there, reads them
//        back, creates the branch lock-first and sets `remote.origin`.
//
// Before the first file, a failure undoes everything it did (the new `.git`,
// the folder if it made it, the bindings). After it, the open finishes or
// stops for recovery on the project's card (finish). Nothing in the
// repository runs: no hooks, no commands, no dependency install.

export interface OpenService {
  plan(repo: RepoRef, destination: string): Promise<RemoteOpenPlan>;
  apply(planId: PlanId, origin: Origin): Promise<RemoteOpenResult>;
}

const NO_CONFLICTS = { count: 0, sample: [] as string[] };

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

// The branch to open: GitHub's default when the repository has it, else
// `main`, else the first one.
function pickBranch(repo: GitHubRepo, heads: Map<string, GitOid>): string | null {
  const names = [...heads.keys()]
    .map((r) => r.slice('refs/heads/'.length))
    .filter((b) => BranchName.safeParse(b).success);
  if (repo.defaultBranch && names.includes(repo.defaultBranch)) return repo.defaultBranch;
  if (names.includes('main')) return 'main';
  return names.sort()[0] ?? null;
}

export function createOpenService(ctx: ProjectContext): OpenService {
  const { store, clock, host, journal } = ctx;

  async function plan(ref: RepoRef, destination: string): Promise<RemoteOpenPlan> {
    const provider = requireProvider(ctx);
    const repoInfo = await provider.getRepo(ref, 'open');
    const dest = await host.inspectDestination(destination);
    const heads = await withGitAccess(ctx, ref, (access) => host.remoteHeads(access));
    const branch = pickBranch(repoInfo, heads);
    const tip = branch !== null ? (heads.get(`refs/heads/${branch}`) ?? null) : null;
    const insideProject = store.listProjects().some((p) => inside(dest.path, p.root));
    const reasons: [boolean, ErrorCode, string][] = [
      [tip === null, 'REMOTE_REJECTED', 'empty-repository'],
      [dest.exists && !dest.empty, 'UNTRACKED_FILES', 'destination-not-empty'],
      [insideProject, 'REPO_UNSUPPORTED', 'inside-another-repo'],
    ];
    const first = reasons.find(([hit]) => hit);
    const createdAt = clock.nowIso();
    const planId = PlanId.parse(crypto.randomUUID());
    const expiresAt = new Date(Date.parse(createdAt) + ctx.planTtlMs).toISOString();
    if (tip !== null && branch !== null) {
      const record: OpenPlanRecord = {
        kind: 'open',
        repo: repoInfo,
        branch,
        tip,
        destination: dest.path,
        existed: dest.exists,
      };
      const fingerprint = await sha256Hex(canonicalJson({ repo: repoInfo.id, branch, tip, destination: dest.path }));
      store.insertPlan({ planId, projectId: null, createdAt, expiresAt, fingerprint, record, consumedBy: null });
    }
    return {
      planId,
      createdAt,
      expiresAt,
      repo: repoInfo,
      branch: branch ?? repoInfo.defaultBranch ?? 'main',
      tip,
      destination: { path: dest.path, exists: dest.exists },
      blocked: first ? { code: first[1], reason: first[2] } : null,
    };
  }

  // The newest version's settings: the project it belongs to (untrusted).
  async function settingsOf(repo: ReturnType<typeof host.openRepo>, files: ReturnType<typeof restorableFiles>) {
    const file = files.find((f) => f.path === PROJECT_CONFIG_FILE);
    if (!file) {
      throw new DtError(
        'CONFIG_INVALID',
        "this repository's newest version has no Draft Tide settings (.drafttide.json)",
        {
          reason: 'missing',
        },
      );
    }
    const bytes = await readSmallBlob(repo, file.oid, MAX_PROJECT_CONFIG_BYTES);
    if (bytes === null) throw new DtError('CONFIG_INVALID', '.drafttide.json is too large', { reason: 'too-large' });
    return parseProjectConfig(bytes);
  }

  async function isProjectFolder(p: ProjectSummary): Promise<boolean> {
    try {
      if ((await host.canonicalRoot(p.root)) !== p.root) return false;
      return (await host.openWorkspace(p.root).readProjectConfig())?.config.projectId === p.projectId;
    } catch {
      return false;
    }
  }

  async function apply(planId: PlanId, origin: Origin): Promise<RemoteOpenResult> {
    const provider = requireProvider(ctx);
    const stored = usablePlan(ctx, null, planId, 'open');
    const record = stored.record as OpenPlanRecord;
    const ref: RepoRef = { owner: record.repo.owner, name: record.repo.name };
    const checkAccess = accessCheck(ctx, origin);

    return ctx.guards.run(BINDINGS_GUARD, async () => {
      const dest = await host.inspectDestination(record.destination);
      if (dest.path !== record.destination) throw stale('changed', 'the folder changed since the plan was made');
      if (dest.exists && !dest.empty) {
        throw new DtError('UNTRACKED_FILES', 'the folder is not empty any more; choose an empty folder', {
          reason: 'destination-not-empty',
        });
      }
      // A repo inside a connected project would stop that project's saves
      // (a nested repository): refused whatever the plan said.
      if (store.listProjects().some((p) => inside(dest.path, p.root))) {
        throw new DtError('REPO_UNSUPPORTED', 'this folder is inside a connected project; choose another', {
          reason: 'inside-another-repo',
        });
      }
      const repoInfo = await provider.getRepo(ref, 'open');
      if (repoInfo.id !== record.repo.id) throw stale('changed', 'the repository changed since the plan was made');
      const operationId = OperationId.parse(crypto.randomUUID());
      if (!store.consumePlan(planId, operationId, clock.nowIso())) {
        throw stale('used', 'this plan was already applied; make a new one');
      }
      checkAccess();

      // ---- Prepare: undone on any failure.
      const { root, created } = await host.prepareDestination(record.destination);
      const repo = host.openRepo(root);
      let config: ProjectConfig;
      let files: ReturnType<typeof restorableFiles>;
      let targetTree: GitOid;
      let snapshotId: OpenJournal['target']['snapshotId'] = null;
      try {
        await repo.init(undefined, { branch: record.branch });
        const tip = await withGitAccess(ctx, ref, (access) => repo.fetchBranch(access, record.branch));
        if (tip !== record.tip) {
          throw stale('history-changed', 'the repository has newer versions since the plan was made; check it again');
        }
        const [commit] = await repo.readCommits([tip]);
        if (!commit) throw new DtError('GIT_FAILED', 'the newest version could not be read');
        targetTree = commit.tree;
        const meta = readCommitMetadata(commit.message);
        if (meta.status === 'snapshot') snapshotId = meta.metadata.snapshotId;
        files = restorableFiles(await repo.listTree(commit.tree));
        config = await settingsOf(repo, files);
        // The files must fit (the objects are already in .git).
        const needed = files.reduce((n, f) => n + f.size, 0) + SPACE_MARGIN_BYTES;
        const space = await host.openWorkspace(root).projectSpace();
        if (space.availableBytes < needed) {
          throw new DtError('INSUFFICIENT_DISK_SPACE', 'not enough free disk space to open this project here', {
            volume: 'project',
            requiredBytes: needed,
            availableBytes: space.availableBytes,
          });
        }
      } catch (e) {
        await host.removeFreshRepo(root, created).catch(() => undefined);
        throw e;
      }

      // ---- Connect the project, journal the open, write.
      const existing = store.getProject(config.projectId);
      if (existing && (await isProjectFolder(existing))) {
        await host.removeFreshRepo(root, created).catch(() => undefined);
        throw new DtError(
          'PROJECT_ALREADY_BOUND',
          'this project is already connected to another folder on this computer',
          {
            projectId: config.projectId,
            root: existing.root,
          },
        );
      }
      const projectId = config.projectId;
      const relinked = existing !== null;
      const binding: RemoteBinding = {
        provider: 'github',
        repoId: repoInfo.id,
        owner: repoInfo.owner,
        name: repoInfo.name,
        visibility: repoInfo.visibility,
        branch: record.branch,
        connectedAt: clock.nowIso(),
      };
      const name = config.name.trim() || repoInfo.name;
      const project: ProjectSummary = relinked
        ? { ...existing, root, name }
        : { projectId, name, root, boundAt: clock.nowIso() };
      const opFiles: OperationFile[] = files.map((f, seq) => ({
        seq,
        path: f.path,
        before: null,
        after: { oid: f.oid, mode: f.mode },
        done: false,
      }));
      const sizes = new Map(files.map((f) => [f.path, f.size]));
      const state = {
        rec: {
          operationId,
          projectId,
          kind: 'open',
          origin,
          state: 'confirmed',
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
          acknowledged: false,
          journal: {
            kind: 'open',
            planId,
            ref: `refs/heads/${record.branch}`,
            remote: ref,
            root,
            createdFolder: created,
            relinkedFrom: relinked && existing ? existing.root : null,
            target: { commit: record.tip, snapshotId },
            targetTree,
            project,
            publish: null,
            reason: null,
            conflicts: NO_CONFLICTS,
            error: null,
          },
        } as OperationRecord,
      };
      const j = () => state.rec.journal as OpenJournal;
      // Before any file is in the folder, a failure undoes the open: the
      // operation fails, the bindings go (or the relinked project gets its
      // folder back), and the new `.git` (and the folder, if the open made
      // it) is removed while nothing else is in it.
      const undo = async (e: unknown) => {
        if (store.getOperation(operationId)) {
          const cancelled = e instanceof DtError && e.code === 'CANCELLED' && state.rec.state !== 'applying';
          move(cancelled ? 'cancelled' : 'failed', { error: operationError(e) });
        }
        if (relinked && existing) store.updateProject(projectId, { root: existing.root, name: existing.name });
        else store.deleteProject(projectId);
        await host.removeFreshRepo(root, created).catch(() => undefined);
      };
      const move = (to: OperationRecord['state'], patch: Partial<OpenJournal> = {}) => {
        state.rec = journal.move(state.rec, to, { ...j(), ...patch });
      };
      const report = ctx.progressReporter({ operationId, origin, projectId }, 'remote.openApply');
      const settled = (outcome: 'completed' | 'failed' | 'recovery-required', e?: unknown) =>
        ctx.publish({
          name: 'operation.settled',
          operationId,
          projectId,
          operation: 'remote.openApply',
          origin,
          outcome,
          code: e === undefined ? null : operationError(e).code,
        });

      try {
        const result = await ctx.runWrite(projectId, { operationId, activity: 'opening', origin }, async (run) => {
          // Everything before the first file is undone on failure.
          try {
            if (relinked) store.updateProject(projectId, { root, name });
            else store.insertProject(project);
            store.putRemote(projectId, binding);
            store.updateRemoteState(projectId, { remoteTip: record.tip, lastCheckAt: clock.nowIso() });
            store.insertOperation(state.rec);
            move('preflight');
            store.insertOperationFiles(operationId, opFiles);
            move('staged');
            await ctx.hooks.checkpoint?.('open:staged');
            checkAccess();
            run.signal.throwIfAborted();
            run.pastPointOfNoReturn();
          } catch (e) {
            await undo(e);
            throw e;
          }
          ctx.publish({ name: 'project.changed', projectId, reason: 'bound' });

          // ---- Past the point of no return: whatever stops it now leaves the
          // operation for recovery (finish), never half-undone.
          try {
            // ---- Past the point of no return.
            const workspace = host.openWorkspace(root);
            move('applying');
            const bytesTotal = files.reduce((n, f) => n + f.size, 0);
            let bytesDone = 0;
            let written = 0;
            const needRecovery = (reason: OpenJournal['reason'], e: unknown, conflicts: string[] = []) => {
              move('recovery-required', {
                reason,
                error: operationError(e),
                conflicts: { count: conflicts.length, sample: conflicts.slice(0, 50) },
              });
              return new DtError(
                'RECOVERY_REQUIRED',
                'opening the project stopped part-way; finish it from the recovery screen of the project',
                { operationId, reason },
              );
            };
            for (const f of opFiles) {
              let ok: boolean;
              try {
                ok = await transition(repo, workspace, f.path, null, f.after);
              } catch (e) {
                if (written === 0) {
                  await undo(e);
                  throw e;
                }
                throw needRecovery('write-failed', e);
              }
              if (!ok && written === 0) {
                const e = stale('external-change', 'another program wrote into the folder; nothing was opened');
                await undo(e);
                throw e;
              }
              if (!ok) {
                throw needRecovery(
                  'external-change',
                  stale('external-change', 'another program wrote into the folder; its file was left as it is'),
                  [f.path],
                );
              }
              written++;
              bytesDone += sizes.get(f.path) ?? 0;
              store.markOperationFile(operationId, f.seq, true);
              const progress: SyncProgress = {
                stage: 'apply',
                filesDone: written,
                filesTotal: opFiles.length,
                bytesDone,
                bytesTotal,
              };
              report(progress);
              await ctx.hooks.checkpoint?.('open:file', { path: f.path, index: written });
            }
            report({ stage: 'verify', filesDone: 0, filesTotal: opFiles.length, bytesDone: 0, bytesTotal: 0 });
            const probe = await repo.probe();
            const states = await fileStates(workspace, opFiles, probe.trustExecutableBit);
            const off = opFiles.filter((_, i) => states[i] !== 'after').map((f) => f.path);
            if (off.length > 0) {
              throw needRecovery(
                'verify-failed',
                new DtError('PLAN_STALE', 'files changed after they were written'),
                off,
              );
            }
            move('verified');
            await recordFastForward(ctx, state, { repo, report });
            await repo.setOrigin((await provider.gitAccess(ref)).url).catch(() => undefined);
            return {
              project: ctx.requireProject(projectId),
              operationId,
              tip: { commit: record.tip, snapshotId },
              files: opFiles.length,
              relinked,
            };
          } catch (caught) {
            if (state.rec.state === 'applying' || state.rec.state === 'verified') {
              const reason = state.rec.state === 'verified' ? 'not-recorded' : 'write-failed';
              move('recovery-required', { reason, error: operationError(caught) });
              throw new DtError(
                'RECOVERY_REQUIRED',
                'opening the project stopped part-way; finish it from the recovery screen of the project',
                { operationId, reason },
              );
            }
            throw caught;
          }
        });
        settled('completed');
        ctx.publish({ name: 'remote.changed', projectId });
        if (origin !== 'gui') ctx.publish({ name: 'operations.changed' });
        return result;
      } catch (e) {
        const outcome =
          state.rec.state === 'recovery-required' || state.rec.state === 'publishing' ? 'recovery-required' : 'failed';
        if (store.getOperation(operationId)) settled(outcome, e);
        if (outcome === 'recovery-required') ctx.publish({ name: 'operations.changed' });
        throw e;
      } finally {
        ctx.dropCaches(projectId);
      }
    });
  }

  return { plan, apply };
}
