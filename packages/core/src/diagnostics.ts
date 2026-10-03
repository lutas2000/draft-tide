import {
  DIAGNOSTICS_LOG_MAX_CHARS,
  DIAGNOSTICS_SCHEMA_VERSION,
  DATA_STORE_PARTS,
  DtError,
  OPERATION_STATES,
  PROTOCOL_VERSION,
  isTerminalState,
  type DataStoreUsage,
  type DiagnosticsOperation,
  type DiagnosticsProject,
  type DiagnosticsReport,
  type ErrorCode,
  type OperationKind,
  type OperationState,
  type ProjectId,
  type ProjectUsage,
  type StorageUsage,
} from '@draft-tide/contracts';
import type { AuthService } from './auth.ts';
import type { ProjectContext } from './context.ts';
import type { DiagnosticsHost, EngineIdentity, OperationRecord, VolumeSpace } from './ports.ts';
import type { PreviewService } from './preview.ts';
import type { ProjectService } from './projects.ts';
import type { SyncService } from './sync.ts';

// 設定與診斷 (M1 plan §4.1): storage use for the app, and a de-identified
// report the user saves and sends. The report's schema (contracts) is the
// boundary for everything structured: labels, states, codes and sizes, no
// names or paths. The one piece of free text, the end of the Engine's log,
// goes through the redactor below, which replaces every value the Engine
// knows to be private (folders, names, accounts, ids, tokens, addresses).

export interface DiagnosticsService {
  usage(): Promise<StorageUsage>;
  report(): Promise<DiagnosticsReport>;
}

// The end of the log a report carries. UTF-8 bytes read from the file; the
// schema bounds the characters.
const LOG_TAIL_BYTES = 192 * 1024;
// Ended operations counted in a report (the journal keeps 30 days).
const ENDED_OPERATIONS_READ = 5000;
const OPEN_OPERATIONS_SHOWN = 100;

const REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPEN_STATES = OPERATION_STATES.filter((state) => !isTerminalState(state));

function reasonOf(value: unknown): string | null {
  return typeof value === 'string' && REASON.test(value) ? value : null;
}

function problemOf(e: unknown): { code: ErrorCode; reason: string | null } {
  if (e instanceof DtError) return { code: e.code, reason: reasonOf(e.details['reason']) };
  return { code: 'INTERNAL_ERROR', reason: null };
}

// ---- Labels and redaction

// Stands in for ids within one report: project-1, id-2, oid-3. The same id
// gets the same label everywhere in the report, the log included.
export interface Labeler {
  project(projectId: string): string;
  // Any other id (operations, snapshots, plans, Engine instances).
  id(value: string): string;
  // A Git object id.
  oid(value: string): string;
  // The label of a project this report knows, by its id or the 8-character
  // prefix the Engine's log uses; null for anything else.
  knownProject(idOrPrefix: string): string | null;
}

export function createLabeler(): Labeler {
  const projects = new Map<string, string>();
  const prefixes = new Map<string, string>();
  const ids = new Map<string, string>();
  const oids = new Map<string, string>();
  const take = (map: Map<string, string>, key: string, kind: string) => {
    let label = map.get(key);
    if (label === undefined) {
      label = `${kind}-${map.size + 1}`;
      map.set(key, label);
    }
    return label;
  };
  return {
    project(projectId) {
      const key = projectId.toLowerCase();
      const label = take(projects, key, 'project');
      prefixes.set(key.slice(0, 8), label);
      return label;
    },
    id: (value) => projects.get(value.toLowerCase()) ?? take(ids, value.toLowerCase(), 'id'),
    oid: (value) => take(oids, value.toLowerCase(), 'oid'),
    knownProject: (v) =>
      projects.get(v.toLowerCase()) ?? (v.length === 8 ? (prefixes.get(v.toLowerCase()) ?? null) : null),
  };
}

export interface PrivateValue {
  value: string;
  label: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Placeholders while redacting, so a later rule never matches inside an
// earlier one's label. Removed from the input first.
const OPEN = '';
const CLOSE = '';
// Bytes that could steer a terminal or hide text; tabs and line breaks stay.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;
const TOKEN = /\b(?:gh[opsur]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OID = /\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/gi;
const SHORT_ID = /\b[0-9a-f]{8}\b/gi;

// Replaces, in order: tokens; the given paths (longest first, so a folder
// inside the home directory keeps its own label); email addresses; the given
// words (names, accounts: case-insensitively, as a whole word when shorter
// than three characters); ids and object ids (labels); the 8-character
// prefixes of known projects' ids. Unprintable characters become U+FFFD.
export function createRedactor(input: {
  paths: readonly PrivateValue[];
  words: readonly PrivateValue[];
  labeler: Labeler;
}): (text: string) => string {
  const paths = [...input.paths].filter((p) => p.value.length > 1).sort((a, b) => b.value.length - a.value.length);
  const words = [...input.words]
    .filter((w) => w.value.trim().length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  return (raw) => {
    const slots: string[] = [];
    const hold = (label: string) => {
      slots.push(label);
      return `${OPEN}${slots.length - 1}${CLOSE}`;
    };
    let text = raw.replace(UNPRINTABLE, '�');
    text = text.replace(TOKEN, () => hold('<token>'));
    for (const p of paths) text = text.split(p.value).join(hold(p.label));
    text = text.replace(EMAIL, () => hold('<email>'));
    for (const w of words) {
      const body = escapeRegExp(w.value);
      const pattern =
        [...w.value].length < 3
          ? new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu')
          : new RegExp(body, 'giu');
      text = text.replace(pattern, () => hold(w.label));
    }
    text = text.replace(UUID, (m) => hold(input.labeler.id(m)));
    text = text.replace(OID, (m) => hold(input.labeler.oid(m)));
    text = text.replace(SHORT_ID, (m) => {
      const label = input.labeler.knownProject(m);
      return label === null ? m : hold(label);
    });
    return text.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i: string) => slots[Number(i)] ?? '');
  };
}

// ---- The service

export function createDiagnosticsService(
  ctx: ProjectContext,
  deps: {
    identity: EngineIdentity;
    host: DiagnosticsHost | undefined;
    projects: ProjectService;
    sync: SyncService;
    auth: AuthService;
    previews: PreviewService;
  },
): DiagnosticsService {
  const { store, clock } = ctx;
  const { host } = deps;

  async function dataStore(): Promise<{ usage: DataStoreUsage; space: VolumeSpace | null }> {
    const zero = Object.fromEntries(DATA_STORE_PARTS.map((p) => [p, 0])) as DataStoreUsage['parts'];
    if (!host) return { usage: { parts: zero, total: 0, availableBytes: null, complete: false }, space: null };
    const [measured, space] = await Promise.all([
      host.dataStoreUsage().catch(() => ({ parts: zero, complete: false })),
      host.dataStoreSpace().catch(() => null),
    ]);
    const parts = { ...zero, ...measured.parts };
    return {
      usage: {
        parts,
        total: DATA_STORE_PARTS.reduce((sum, p) => sum + parts[p], 0),
        availableBytes: space?.availableBytes ?? null,
        complete: measured.complete,
      },
      space,
    };
  }

  // One project at a time: each asks Git and the filesystem, never the
  // network, and reads nothing inside the folder but `.git`'s size.
  async function projectUsage(projectId: ProjectId, name: string, space: VolumeSpace | null): Promise<ProjectUsage> {
    const p = store.getProject(projectId);
    const unread: ProjectUsage = {
      projectId,
      name,
      historyBytes: null,
      availableBytes: null,
      sameVolumeAsDataStore: null,
    };
    if (!p) return unread;
    try {
      const { repo, workspace } = await ctx.openBound(p);
      const [historyBytes, projectSpace] = await Promise.all([
        repo.objectStoreSize().catch(() => null),
        workspace.projectSpace().catch(() => null),
      ]);
      return {
        ...unread,
        historyBytes,
        availableBytes: projectSpace?.availableBytes ?? null,
        sameVolumeAsDataStore: projectSpace && space ? projectSpace.volume === space.volume : null,
      };
    } catch {
      return unread;
    }
  }

  async function usage(): Promise<StorageUsage> {
    const { usage: ds, space } = await dataStore();
    const projects: ProjectUsage[] = [];
    for (const p of store.listProjects()) projects.push(await projectUsage(p.projectId, p.name, space));
    return { dataStore: ds, projects, measuredAt: clock.nowIso() };
  }

  async function report(): Promise<DiagnosticsReport> {
    const createdAt = clock.nowIso();
    const labeler = createLabeler();
    const bound = store.listProjects();
    for (const p of bound) labeler.project(p.projectId);
    const remotes = new Map(store.listRemotes().map((r) => [r.projectId, r]));
    const [auth, environment, storage] = await Promise.all([
      deps.auth.status(true).catch(() => null),
      host?.environment().catch(() => null) ?? Promise.resolve(null),
      usage(),
    ]);
    const usageOf = new Map(storage.projects.map((u) => [u.projectId, u]));

    // Everything private the Engine knows of, for the log.
    const paths: PrivateValue[] = [];
    const words: PrivateValue[] = [];
    for (const p of bound) {
      const label = labeler.project(p.projectId);
      paths.push({ value: p.root, label: `<${label} folder>` });
      words.push({ value: p.name, label: `<${label} name>` });
    }
    for (const r of remotes.values()) {
      const label = labeler.project(r.projectId);
      words.push({ value: `${r.remote.owner}/${r.remote.name}`, label: `<${label} repository>` });
      words.push({ value: r.remote.owner, label: '<github-account>' });
      words.push({ value: r.remote.name, label: `<${label} repository>` });
    }
    if (auth?.user) {
      words.push({ value: auth.user.login, label: '<github-account>' });
      if (auth.user.name) words.push({ value: auth.user.name, label: '<github-name>' });
    }
    // The journal, read once. A row that can't be read back fails the whole
    // read (STORAGE_IO_FAILED): the report says so instead of failing.
    let records: OperationRecord[] = [];
    let readError: { code: ErrorCode; reason: string | null } | null = null;
    try {
      records = store.listOperations({ newestFirst: true, limit: ENDED_OPERATIONS_READ });
    } catch (e) {
      readError = problemOf(e);
    }
    // Folders agents asked the user to connect.
    for (const rec of records) {
      if (rec.journal.kind === 'connect-request') {
        paths.push({ value: rec.journal.root, label: '<requested folder>' });
        if (rec.journal.name) words.push({ value: rec.journal.name, label: '<requested name>' });
      }
    }
    const fromHost = host?.privateValues() ?? { paths: [], words: [] };
    for (const value of fromHost.paths) paths.push({ value, label: '<private path>' });
    for (const value of fromHost.words) words.push({ value, label: '<private name>' });
    const redact = createRedactor({ paths, words, labeler });

    const projects: DiagnosticsProject[] = [];
    for (const p of bound) {
      const u = usageOf.get(p.projectId);
      const entry: DiagnosticsProject = {
        label: labeler.project(p.projectId),
        folder: null,
        checkError: null,
        blockers: [],
        recoveryRequired: false,
        hasVersions: false,
        historyBytes: u?.historyBytes ?? null,
        availableBytes: u?.availableBytes ?? null,
        sameVolumeAsDataStore: u?.sameVolumeAsDataStore ?? null,
        sync: null,
      };
      try {
        const s = await deps.projects.status(p.projectId, { changes: false });
        entry.folder = s.folder;
        entry.blockers = s.blockers.slice(0, 64).map((b) => ({ code: b.code, reason: b.reason }));
        entry.recoveryRequired = s.recoveryRequired;
        entry.hasVersions = s.tip !== null;
      } catch (e) {
        entry.checkError = problemOf(e);
      }
      const remote = remotes.get(p.projectId);
      if (remote) {
        const queued = store.getQueuedPush(p.projectId);
        const s = await deps.sync.status(p.projectId, false).catch(() => null);
        const lastError = s?.lastError ?? remote.lastError;
        entry.sync = {
          state: s?.state ?? null,
          visibility: remote.remote.visibility,
          ahead: s?.ahead ?? null,
          behind: s?.behind ?? null,
          lastError: lastError ? { code: lastError.code, reason: reasonOf(lastError.reason) } : null,
          queuedPushAttempts: queued?.attempts ?? null,
        };
      }
      projects.push(entry);
    }

    const labelOfProject = (id: ProjectId | null) => (id === null ? null : labeler.project(id));
    // Unfinished operations are never pruned, however old.
    let openRecords: OperationRecord[] = [];
    try {
      openRecords = store.listOperations({ states: OPEN_STATES, newestFirst: true, limit: OPEN_OPERATIONS_SHOWN });
    } catch (e) {
      readError ??= problemOf(e);
    }
    const open: DiagnosticsOperation[] = openRecords.map((r) => ({
      label: labeler.id(r.operationId),
      kind: r.kind,
      state: r.state,
      origin: r.origin,
      project: labelOfProject(r.projectId),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      error: r.journal.error?.code ?? null,
    }));
    const counted = new Map<
      string,
      { kind: OperationKind; state: OperationState; error: ErrorCode | null; count: number }
    >();
    for (const r of records) {
      if (!isTerminalState(r.state)) continue;
      const error = r.journal.error?.code ?? null;
      const key = `${r.kind}\n${r.state}\n${error ?? ''}`;
      const c = counted.get(key);
      if (c) c.count++;
      else counted.set(key, { kind: r.kind, state: r.state, error, count: 1 });
    }

    const log = host ? await host.logTail(LOG_TAIL_BYTES).catch(() => null) : null;
    let logText = log ? redact(log.text) : '';
    let truncated = log?.truncated ?? false;
    if (logText.length > DIAGNOSTICS_LOG_MAX_CHARS) {
      const cut = logText.length - DIAGNOSTICS_LOG_MAX_CHARS;
      const next = logText.indexOf('\n', cut);
      logText = next < 0 ? '' : logText.slice(next + 1);
      truncated = true;
    }

    const previews = deps.previews.status();
    const { identity } = deps;
    return {
      kind: 'draft-tide-diagnostics',
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      createdAt,
      app: {
        version: identity.appVersion,
        protocolVersion: PROTOCOL_VERSION,
        storageSchemaVersion: store.storageSchemaVersion,
        desktopIdentity: identity.desktopIdentity,
        engineStartedAt: identity.startedAt,
        runtime: {
          node: identity.runtime.node,
          sqlite: store.sqliteVersion,
          platform: identity.runtime.platform,
          arch: identity.runtime.arch,
          osRelease: (environment?.osRelease ?? '').slice(0, 64),
          git: environment?.git?.slice(0, 64) ?? null,
        },
      },
      agentAccess: { enabled: store.getAgentAccess().enabled },
      github: { state: auth?.state ?? 'unavailable', unavailableReason: auth?.unavailableReason ?? null },
      previews: {
        available: previews.available,
        renderer: previews.renderer,
        entries: previews.cache.entries,
        bytes: previews.cache.bytes,
      },
      dataStore: storage.dataStore,
      projects,
      operations: { open, ended: [...counted.values()], readError },
      log: { text: logText, truncated },
    };
  }

  return { usage, report };
}
