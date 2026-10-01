import {
  DRAFT_TIDE_IDENTITY,
  DtError,
  OperationId,
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectId,
  STATUS_CHANGES_MAX,
  canonicalJson,
  isSafeRelativePath,
  serializeProjectConfig,
  type BindingState,
  type CommitIdentity,
  type EngineEvent,
  type ErrorCode,
  type ExistingConfig,
  type FileDiff,
  type FolderReview,
  type FolderState,
  type HistoryPage,
  type Origin,
  type ProjectBindResult,
  type ProjectConfig,
  type ProjectStatus,
  type ProjectSummary,
  type SaveProgress,
  type SavedSnapshot,
  type SnapshotDiff,
} from '@draft-tide/contracts';
import {
  TEXT_DIFF_BUDGET,
  diffFileContent,
  diffTreeFiles,
  takeWithinBudget,
  type DiffSide,
  type TreeFileAt,
} from './compare.ts';
import { buildLineIndex, historyEntryOf, resolveVersionRef, versionInfoOf, type LineIndex } from './history.ts';
import type {
  Clock,
  EventSink,
  GitOid,
  GitTreeEntry,
  LocalStore,
  ProjectConfigRead,
  ProjectGit,
  ProjectHost,
  RepoProbe,
  Workspace,
} from './ports.ts';
import { saveSnapshot } from './save.ts';
import { assertNoBlockers, assertSupportedEntries, reviewScope, type ScopeReview } from './scope.ts';
import { gitBlobId, sha256Hex } from './text.ts';
import { HashCache, workingStatus } from './working.ts';
import { createProjectWriteGuards, type ProjectWriteGuards } from './write-guards.ts';

// The project use cases behind the catalog's project, snapshot and history
// operations (M1-04): review and connect a folder, read its status, save a
// version, list history and compare versions. Every channel reaches the same
// functions; who may call what is decided before (policy.ts).

export interface ProjectServiceOptions {
  store: LocalStore;
  host: ProjectHost;
  clock: Clock;
  events: EventSink;
  guards?: ProjectWriteGuards;
  // Before GitHub sign-in (M1-07), the fixed Draft Tide identity.
  identity?: CommitIdentity;
  // At most one progress event per operation this often (and on every stage
  // change).
  progressIntervalMs?: number;
  // Tests shorten capture retries and the wait for another Git's lock.
  retryDelayMs?: (attempt: number) => number;
  lockWaitMs?: number;
}

export interface ProjectService {
  review(root: string, signal?: AbortSignal): Promise<FolderReview>;
  bind(input: {
    root: string;
    name: string;
    entryFiles: string[];
    reviewToken: string;
    asNewProject?: boolean | undefined;
  }): Promise<ProjectBindResult>;
  status(projectId: ProjectId): Promise<ProjectStatus>;
  save(projectId: ProjectId, name: string | undefined, origin: Origin): Promise<SavedSnapshot>;
  history(projectId: ProjectId, page: { skip: number; limit: number }): Promise<HistoryPage>;
  diff(projectId: ProjectId, from: string, to: string): Promise<SnapshotDiff>;
  diffFile(projectId: ProjectId, from: string, to: string, path: string): Promise<FileDiff>;
}

// Connecting folders is serialized; saves of one project are serialized with
// each other and with a relink of that project.
const BINDINGS_GUARD = 'bindings';
const MAX_CHANGES_BYTES = 640 * 1024;
const MAX_DIFF_CHANGES = 5000;

function codeOf(e: unknown): ErrorCode | null {
  return e instanceof DtError ? e.code : null;
}

function folderName(root: string): string {
  return (
    root
      .split(/[\\/]/)
      .filter((s) => s !== '')
      .at(-1) ?? root
  ).slice(0, 200);
}

interface Reviewed {
  root: string;
  dto: FolderReview;
  scope: ScopeReview;
  configRead: ProjectConfigRead | null;
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const { store, host, clock, events } = options;
  const guards = options.guards ?? createProjectWriteGuards();
  const identity = options.identity ?? DRAFT_TIDE_IDENTITY;
  const progressIntervalMs = options.progressIntervalMs ?? 150;
  // Rebuildable views of Git, per project (M1 plan §6.1): digests of
  // unchanged files for status, and the branch's line for history.
  const hashCaches = new Map<ProjectId, HashCache>();
  const lineIndexes = new Map<ProjectId, LineIndex>();

  const publish = (event: EngineEvent) => events.publish(event);

  function requireProject(projectId: ProjectId): ProjectSummary {
    const p = store.getProject(projectId);
    if (!p) throw new DtError('PROJECT_NOT_BOUND', 'no connected project has this id', { projectId });
    return p;
  }

  // The bound folder, still at the same canonical path. A folder that is gone,
  // or whose path now leads elsewhere (a symlink swapped in), is unavailable:
  // nothing is read from wherever it points now.
  async function openBound(p: ProjectSummary): Promise<{ root: string; repo: ProjectGit; workspace: Workspace }> {
    const root = await host.canonicalRoot(p.root);
    if (root !== p.root) {
      throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'the project folder now resolves to another location', {
        reason: 'moved',
      });
    }
    return { root, repo: host.openRepo(root), workspace: host.openWorkspace(root) };
  }

  // A repo whose branch can be read: present, on a branch, in a form Git and
  // Draft Tide can read. A Git operation in progress doesn't stop reading.
  async function readableRepo(repo: ProjectGit): Promise<RepoProbe & { headRef: string; branch: string }> {
    const probe = await repo.probe();
    if (!probe.hasRepo) {
      throw new DtError('LOCAL_ROOT_UNAVAILABLE', "the design folder's history (.git) is missing", {
        reason: 'repo-missing',
      });
    }
    if (probe.headRef === null || probe.branch === null) {
      assertNoBlockers(probe.blockers);
      throw new DtError('GIT_FAILED', 'the current branch could not be read');
    }
    return probe as RepoProbe & { headRef: string; branch: string };
  }

  async function lineIndex(projectId: ProjectId, repo: ProjectGit, tip: GitOid): Promise<LineIndex> {
    const cached = lineIndexes.get(projectId);
    if (cached?.tip === tip) return cached;
    const built = await buildLineIndex(repo, tip);
    lineIndexes.set(projectId, built);
    return built;
  }

  // ---- review and bind

  async function isProjectFolder(p: ProjectSummary): Promise<boolean> {
    try {
      if ((await host.canonicalRoot(p.root)) !== p.root) return false;
      return (await host.openWorkspace(p.root).readProjectConfig())?.config.projectId === p.projectId;
    } catch {
      return false;
    }
  }

  async function reviewFolder(rootInput: string, signal?: AbortSignal): Promise<Reviewed> {
    const root = await host.canonicalRoot(rootInput);
    const workspace = host.openWorkspace(root);
    let configRead: ProjectConfigRead | null = null;
    let config: ExistingConfig = { status: 'missing' };
    try {
      configRead = await workspace.readProjectConfig();
      if (configRead) {
        const { projectId, name, entryFiles } = configRead.config;
        config = { status: 'valid', projectId, name, entryFiles };
      }
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'CONFIG_INVALID') throw e;
      const reason = e.details['reason'];
      config = {
        status: 'invalid',
        reason: reason as Extract<ExistingConfig, { status: 'invalid' }>['reason'],
        details: e.details,
      };
    }

    const projectRepo = host.openRepo(root);
    const hasRepo = (await projectRepo.probe(signal)).hasRepo;
    const listing = hasRepo ? null : await host.openListingRepo(root);
    let scope: ScopeReview;
    try {
      scope = await reviewScope(listing?.repo ?? projectRepo, workspace, configRead?.config ?? null, signal);
    } finally {
      await listing?.dispose();
    }

    let binding: BindingState = { status: 'new' };
    const here = store.findProjectByRoot(root);
    if (here) binding = { status: 'bound-here', project: here };
    else if (configRead) {
      const elsewhere = store.getProject(configRead.config.projectId);
      if (elsewhere)
        binding = { status: 'bound-elsewhere', project: elsewhere, available: await isProjectFolder(elsewhere) };
    }
    const freeBytes = await workspace.projectSpace().then(
      (s) => Math.max(0, Math.floor(s.availableBytes)),
      () => null,
    );
    const reviewToken = await sha256Hex(
      canonicalJson({
        root,
        scope: scope.fingerprint,
        config: configRead?.oid ?? config.status,
        binding: binding.status === 'new' ? 'new' : `${binding.status}:${binding.project.projectId}`,
      }),
    );
    const { probe } = scope;
    const dto: FolderReview = {
      root,
      folderName: folderName(root),
      repo: { hasRepo: probe.hasRepo, branch: probe.branch, tip: probe.tip, warnings: probe.warnings },
      blockers: scope.blockers,
      scopeListed: !probe.blockers.some((b) => b.code === 'REPO_UNSUPPORTED'),
      included: scope.included,
      deleted: scope.deleted,
      unsupported: { count: scope.unsupported.count, entries: scope.unsupported.entries.slice(0, 100) },
      excluded: scope.excluded,
      excludedByDefaults: scope.excludedByDefaults,
      entryFiles: scope.entryFiles,
      entryCandidates: scope.entryCandidates,
      config,
      binding,
      suggestedName: (configRead?.config.name.trim() || folderName(root)).slice(0, 200),
      freeBytes,
      reviewToken,
    };
    return { root, dto, scope, configRead };
  }

  async function bind(input: Parameters<ProjectService['bind']>[0]): Promise<ProjectBindResult> {
    return guards.run(BINDINGS_GUARD, async () => {
      // The folder must still be what the user reviewed and confirmed.
      const reviewed = await reviewFolder(input.root);
      const { root, dto, scope, configRead } = reviewed;
      if (dto.reviewToken !== input.reviewToken) {
        throw new DtError('SCOPE_CHANGED', 'the folder changed since it was reviewed; review it again', {});
      }
      if (dto.binding.status === 'bound-here') {
        return { project: dto.binding.project, initialized: false, configWritten: false, relinked: false };
      }
      // Everything that would stop the first save stops connecting, before
      // anything is written.
      if (dto.config.status === 'invalid') {
        throw new DtError(
          'CONFIG_INVALID',
          ".drafttide.json can't be used; fix or remove it first",
          dto.config.details,
        );
      }
      assertNoBlockers(dto.blockers);
      assertSupportedEntries(scope.unsupported.entries);
      const included = new Set(scope.includedPaths);
      const entryFiles = [...new Set(input.entryFiles)];
      for (const e of entryFiles) {
        if (!included.has(e)) {
          throw new DtError('INVALID_ARGUMENT', 'an entry page must be a file that is saved', {
            reason: 'entry-not-included',
          });
        }
      }

      let projectId: ProjectId;
      let relinked = false;
      if (input.asNewProject === true || !configRead) {
        projectId = ProjectId.parse(crypto.randomUUID());
      } else {
        projectId = configRead.config.projectId;
        if (dto.binding.status === 'bound-elsewhere') {
          if (dto.binding.available) {
            throw new DtError(
              'PROJECT_ALREADY_BOUND',
              "this folder's settings name a project that is connected to another folder",
              { projectId, root: dto.binding.project.root },
            );
          }
          relinked = true;
        }
      }
      const name = input.name.trim() || dto.suggestedName;
      const config: ProjectConfig = {
        schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
        projectId,
        name,
        entryFiles,
        excludeDirNames: configRead?.config.excludeDirNames ?? [],
        excludeFilePatterns: configRead?.config.excludeFilePatterns ?? [],
      };
      const bytes = new TextEncoder().encode(serializeProjectConfig(config));

      return guards.run(projectId, async () => {
        let initialized = false;
        if (!dto.repo.hasRepo) {
          await host.openRepo(root).init();
          initialized = true;
        }
        const configWritten = configRead?.oid !== (await gitBlobId(bytes));
        if (configWritten) await host.openWorkspace(root).writeProjectConfig(bytes, configRead?.oid ?? null);
        let project: ProjectSummary;
        if (relinked) {
          store.updateProject(projectId, { root, name });
          project = requireProject(projectId);
        } else {
          project = { projectId, name, root, boundAt: clock.nowIso() };
          store.insertProject(project);
        }
        hashCaches.delete(projectId);
        lineIndexes.delete(projectId);
        publish({ name: 'project.changed', projectId, reason: 'bound' });
        return { project, initialized, configWritten, relinked };
      });
    });
  }

  // ---- status

  async function status(projectId: ProjectId): Promise<ProjectStatus> {
    const p = requireProject(projectId);
    const result: ProjectStatus = {
      project: p,
      folder: 'available',
      configProblem: null,
      name: p.name,
      entryFiles: [],
      branch: null,
      tip: null,
      blockers: [],
      warnings: [],
      recoveryRequired: false,
      saving: guards.isBusy(projectId),
      changes: null,
      unsupported: { count: 0, entries: [] },
      checkedAt: clock.nowIso(),
    };
    let opened: Awaited<ReturnType<typeof openBound>>;
    try {
      opened = await openBound(p);
    } catch (e) {
      if (codeOf(e) === 'LOCAL_ROOT_UNAVAILABLE') return { ...result, folder: 'missing' };
      throw e;
    }
    const { repo, workspace } = opened;
    const probe = await repo.probe();
    if (!probe.hasRepo) return { ...result, folder: 'repo-missing', blockers: probe.blockers };
    result.blockers = probe.blockers;
    result.warnings = probe.warnings;
    result.branch = probe.branch;

    let config: ProjectConfig | null = null;
    let folder: FolderState = 'available';
    try {
      const read = await workspace.readProjectConfig();
      if (!read) folder = 'config-missing';
      else if (read.config.projectId !== projectId) folder = 'project-mismatch';
      else config = read.config;
    } catch (e) {
      if (!(e instanceof DtError) || e.code !== 'CONFIG_INVALID') throw e;
      folder = 'config-invalid';
      const reason = e.details['reason'] as NonNullable<ProjectStatus['configProblem']>['reason'];
      result.configProblem = { reason, details: e.details };
    }
    result.folder = folder;
    if (config) {
      result.name = config.name || p.name;
      result.entryFiles = config.entryFiles;
    }
    if (probe.headRef === null) return result;

    const lock = await repo.indexLock();
    result.recoveryRequired = lock.held && lock.by === 'draft-tide';
    let tipFiles: GitTreeEntry[] = [];
    if (probe.tip !== null) {
      const index = await lineIndex(projectId, repo, probe.tip);
      const [commit] = await repo.readCommits([probe.tip]);
      if (commit) {
        result.tip = historyEntryOf(commit, index);
        if (config) tipFiles = (await repo.listTree(commit.tree)).entries;
      }
    }
    if (!config || probe.blockers.some((b) => b.code === 'REPO_UNSUPPORTED')) return result;

    let cache = hashCaches.get(projectId);
    if (!cache) hashCaches.set(projectId, (cache = new HashCache()));
    const working = await workingStatus({
      repo,
      workspace,
      probe,
      config,
      tipFiles,
      cache,
      nowMs: Date.parse(clock.nowIso()),
    });
    const { taken } = takeWithinBudget(working.changes.slice(0, STATUS_CHANGES_MAX), MAX_CHANGES_BYTES);
    result.changes = { ...working.counts, entries: taken };
    result.blockers = [...probe.blockers, ...working.blockers];
    result.unsupported = { count: working.unsupported.length, entries: working.unsupported.slice(0, 100) };
    return result;
  }

  // ---- save

  async function save(projectId: ProjectId, name: string | undefined, origin: Origin): Promise<SavedSnapshot> {
    const p = requireProject(projectId);
    const operationId = OperationId.parse(crypto.randomUUID());
    const settled = (outcome: 'completed' | 'no-changes' | 'failed', code: ErrorCode | null) =>
      publish({
        name: 'operation.settled',
        operationId,
        projectId,
        operation: 'snapshot.create',
        origin,
        outcome,
        code,
      });
    let lastStage = '';
    let lastAt = 0;
    const onProgress = (progress: SaveProgress) => {
      const now = Date.now();
      if (progress.stage === lastStage && now - lastAt < progressIntervalMs) return;
      lastStage = progress.stage;
      lastAt = now;
      publish({ name: 'operation.progress', operationId, projectId, operation: 'snapshot.create', origin, progress });
    };

    return guards.run(projectId, async () => {
      try {
        const { repo, workspace } = await openBound(p);
        const configName = await workspace.readProjectConfig().then(
          (r) => (r?.config.projectId === projectId ? r.config.name : null),
          () => null,
        );
        const saved = await saveSnapshot({
          repo,
          workspace,
          staging: await host.createStaging(projectId, operationId),
          operationId,
          projectId,
          origin,
          name,
          identity,
          clock,
          onProgress,
          ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
          ...(options.lockWaitMs !== undefined ? { lockWaitMs: options.lockWaitMs } : {}),
        });
        // The list shows the name the settings carry.
        if (configName && configName !== p.name) store.updateProject(projectId, { name: configName });
        settled('completed', null);
        publish({ name: 'project.changed', projectId, reason: 'saved' });
        const trimmed = name?.trim();
        return {
          projectId,
          snapshotId: saved.snapshotId,
          kind: saved.kind,
          name: trimmed ? trimmed : null,
          createdAt: saved.createdAt,
          origin,
          commit: saved.commit,
          tree: saved.tree,
          parent: saved.parent,
          branch: saved.branch,
          files: saved.files,
          bytes: saved.bytes,
          newObjects: saved.newObjects,
          newBytes: saved.newBytes,
        };
      } catch (e) {
        const code = codeOf(e);
        settled(code === 'NO_CHANGES' ? 'no-changes' : 'failed', code ?? 'INTERNAL_ERROR');
        throw e;
      }
    });
  }

  // ---- history and comparison

  async function history(projectId: ProjectId, page: { skip: number; limit: number }): Promise<HistoryPage> {
    const p = requireProject(projectId);
    const { repo } = await openBound(p);
    const probe = await readableRepo(repo);
    if (probe.tip === null) {
      return { branch: probe.branch, tip: null, total: 0, versions: 0, entries: [], nextSkip: null };
    }
    const index = await lineIndex(projectId, repo, probe.tip);
    const oids = index.commits.slice(page.skip, page.skip + page.limit);
    const commits = await repo.readCommits(oids);
    const next = page.skip + oids.length;
    return {
      branch: probe.branch,
      tip: probe.tip,
      total: index.commits.length,
      versions: index.seqOf.size,
      entries: commits.map((c) => historyEntryOf(c, index)),
      nextSkip: next < index.commits.length ? next : null,
    };
  }

  async function versionsOf(projectId: ProjectId, from: string, to: string) {
    const p = requireProject(projectId);
    const { repo } = await openBound(p);
    const probe = await readableRepo(repo);
    if (probe.tip === null) throw new DtError('SNAPSHOT_NOT_FOUND', 'the project has no versions yet', { ref: from });
    const index = await lineIndex(projectId, repo, probe.tip);
    const [a, b] = await repo.readCommits([resolveVersionRef(index, from), resolveVersionRef(index, to)]);
    if (!a || !b) throw new DtError('GIT_FAILED', 'a version could not be read');
    return { repo, index, a, b };
  }

  const treeFiles = (entries: readonly GitTreeEntry[]): TreeFileAt[] =>
    entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid, size: e.size }));

  async function diff(projectId: ProjectId, from: string, to: string): Promise<SnapshotDiff> {
    const { repo, index, a, b } = await versionsOf(projectId, from, to);
    const [left, right] = await Promise.all([repo.listTree(a.tree), repo.listTree(b.tree)]);
    const { changes, summary } = diffTreeFiles(treeFiles(left.entries), treeFiles(right.entries));
    const { taken, truncated } = takeWithinBudget(changes.slice(0, MAX_DIFF_CHANGES), MAX_CHANGES_BYTES);
    return {
      from: versionInfoOf(a, index),
      to: versionInfoOf(b, index),
      summary,
      changes: taken,
      truncated: truncated || changes.length > MAX_DIFF_CHANGES,
    };
  }

  async function readSide(repo: ProjectGit, entry: GitTreeEntry | null): Promise<DiffSide | null> {
    if (!entry) return null;
    const file = { mode: entry.mode, oid: entry.oid, size: entry.size };
    const isFile = entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
    if (!isFile || entry.size === null || entry.size > TEXT_DIFF_BUDGET.maxBytesPerSide) return { file, bytes: null };
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of repo.streamBlob(entry.oid)) {
      chunks.push(chunk);
      length += chunk.byteLength;
      if (length > TEXT_DIFF_BUDGET.maxBytesPerSide) return { file, bytes: null };
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { file, bytes };
  }

  async function diffFile(projectId: ProjectId, from: string, to: string, path: string): Promise<FileDiff> {
    if (!isSafeRelativePath(path)) {
      throw new DtError('INVALID_ARGUMENT', 'not a path inside the project', { reason: 'invalid-path' });
    }
    const { repo, a, b } = await versionsOf(projectId, from, to);
    const [left, right] = await Promise.all([repo.lookupPath(a.tree, path), repo.lookupPath(b.tree, path)]);
    if (!left && !right) {
      throw new DtError('INVALID_ARGUMENT', 'the file is in neither version', { reason: 'path-not-found' });
    }
    const [before, after] = await Promise.all([readSide(repo, left), readSide(repo, right)]);
    return diffFileContent(path, before, after);
  }

  return {
    review: async (root, signal) => (await reviewFolder(root, signal)).dto,
    bind,
    status,
    save,
    history,
    diff,
    diffFile,
  };
}
