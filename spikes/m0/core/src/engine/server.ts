// M0 Engine spike: the only writer. Holds a crash-safe single-instance lock,
// serves length-framed JSON on a Unix socket, keeps local state in SQLite
// (better-sqlite3, companion Node only) and history in per-project bare Git.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { DtError } from '../shared/errors.ts';
import { gitVersion, resolveGitRuntime } from '../shared/git.ts';
import { DEFAULT_SCOPE_POLICY, type ScopePolicy } from '../storage/scope.ts';
import { ProjectStore, type RestorePlan } from '../storage/store.ts';
import type { SnapshotKind } from '../storage/metadata.ts';
import { resolveDataDir, runtimePaths } from './paths.ts';
import { PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, readFrames, writeFrame, type ClientKind, type Request } from './protocol.ts';

process.umask(0o077);
const dataDir = resolveDataDir();
const paths = runtimePaths(dataDir);
mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
const log = (msg: string) => process.stderr.write(`[engine ${process.pid}] ${msg}\n`);

// ---- single instance: an EXCLUSIVE SQLite lock held for the Engine's life.
// It is an OS (fcntl / LockFileEx) lock, so a crashed Engine releases it
// automatically; no pid or file-age guessing is needed to take over.
const lockDb = new Database(paths.lockDb);
lockDb.pragma('busy_timeout = 0');
lockDb.pragma('locking_mode = EXCLUSIVE');
try {
  lockDb.exec('BEGIN EXCLUSIVE');
} catch (e) {
  log(`another engine owns ${paths.lockDb}; exiting (${(e as Error).message})`);
  process.exit(0);
}

const instanceId = randomUUID();
const toolToken = randomBytes(32).toString('base64url');
const desktopToken = randomBytes(32).toString('base64url');
const startedAt = new Date().toISOString();
const rt = resolveGitRuntime(dataDir);
const gitVer = await gitVersion(rt);

// ---- local state
const db = new Database(join(dataDir, 'state.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 2000');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    entry_files TEXT NOT NULL, policy TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
    kind TEXT NOT NULL, state TEXT NOT NULL, requested_by TEXT NOT NULL, plan TEXT NOT NULL,
    fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL, result TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
    decision TEXT NOT NULL, caller TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
`);
db.prepare(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('storageSchemaVersion', ?)`).run(String(STORAGE_SCHEMA_VERSION));
const storedSchema = Number((db.prepare(`SELECT value FROM schema_meta WHERE key = 'storageSchemaVersion'`).get() as { value: string }).value);
if (storedSchema !== STORAGE_SCHEMA_VERSION) {
  log(`storage schema ${storedSchema} is not supported by this engine (${STORAGE_SCHEMA_VERSION}); refusing to write`);
  process.exit(3);
}
const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

type ProjectRow = { project_id: string; root: string; display_name: string; entry_files: string; policy: string; created_at: string };
type OperationRow = { operation_id: string; project_id: string; kind: string; state: string; requested_by: string; plan: string; fingerprint: string; expires_at: string; result: string | null; error: string | null };
const stores = new Map<string, ProjectStore>();
function storeFor(projectId: unknown): ProjectStore {
  if (typeof projectId !== 'string') throw new DtError('PROJECT_NOT_BOUND', 'projectId is required');
  const cached = stores.get(projectId);
  if (cached) return cached;
  const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined;
  if (!row) throw new DtError('PROJECT_NOT_BOUND', 'unknown project', { projectId });
  const s = ProjectStore.open(dataDir, rt, { projectId: row.project_id, root: row.root, entryFiles: JSON.parse(row.entry_files) as string[], policy: JSON.parse(row.policy) as ScopePolicy });
  stores.set(projectId, s);
  return s;
}

// ---- discovery file (tool credential) and desktop credential.
// M0 placeholder: the desktop credential is a 0600 file, which is NOT a
// boundary against other code running as the same OS user. M1-00 must replace
// it with OS-verified peer identity (see docs/safety-model.md).
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${instanceId}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}
if (existsSync(paths.socket)) unlinkSync(paths.socket); // safe: we hold the lock
writeAtomic(paths.desktopToken, desktopToken);

let clients = 0;
let activeOps = 0;
let lastActivity = Date.now();
const desktopSockets = new Set<Socket>();
const IDLE_MS = Number(process.env['DRAFT_TIDE_ENGINE_IDLE_MS'] ?? 15_000);

function emitDesktop(event: Record<string, unknown>): void {
  for (const s of desktopSockets) writeFrame(s, { event: event['event'], ...event });
}

function now(): string {
  return new Date().toISOString();
}

function planSummary(p: RestorePlan) {
  return {
    overwrite: p.writes.filter((w) => w.action === 'overwrite').length,
    add: p.writes.filter((w) => w.action === 'add').length,
    delete: p.deletes.length,
    unsavedChangesWillBeProtected: p.unsavedChanges,
    untrackedBlocking: p.untracked,
    expiresAt: p.expiresAt,
  };
}

function operationView(row: OperationRow) {
  const approval = db.prepare('SELECT decision, consumed_at, expires_at FROM approvals WHERE operation_id = ?').get(row.operation_id) as { decision: string; consumed_at: string | null; expires_at: string } | undefined;
  return {
    operationId: row.operation_id,
    projectId: row.project_id,
    kind: row.kind,
    state: row.state,
    requestedBy: row.requested_by,
    summary: planSummary(JSON.parse(row.plan) as RestorePlan),
    approval: approval ? { decision: approval.decision, consumed: !!approval.consumed_at, expiresAt: approval.expires_at } : null,
    result: row.result ? (JSON.parse(row.result) as unknown) : null,
    error: row.error ? (JSON.parse(row.error) as unknown) : null,
  };
}

function getOperation(operationId: unknown): OperationRow {
  if (typeof operationId !== 'string') throw new DtError('PLAN_STALE', 'operationId is required');
  const row = db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId) as OperationRow | undefined;
  if (!row) throw new DtError('PLAN_STALE', 'unknown operation', { operationId });
  return row;
}

function setState(operationId: string, state: string, extra: { result?: unknown; error?: unknown } = {}): void {
  db.prepare('UPDATE operations SET state = ?, result = COALESCE(?, result), error = COALESCE(?, error), updated_at = ? WHERE operation_id = ?').run(
    state,
    extra.result === undefined ? null : JSON.stringify(extra.result),
    extra.error === undefined ? null : JSON.stringify(extra.error),
    now(),
    operationId,
  );
}

const kindFor: Record<ClientKind, SnapshotKind> = { desktop: 'manual', cli: 'manual', harness: 'manual', mcp: 'agent-requested' };
const originFor = { desktop: 'gui', cli: 'cli', mcp: 'mcp', harness: 'harness' } as const;

type Handler = (payload: Record<string, unknown>, caller: ClientKind) => Promise<unknown> | unknown;
// Tool channel (CLI / MCP): no approve operation exists here at all.
const toolOps: Record<string, Handler> = {
  'engine.info': () => ({
    instanceId,
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    nodeVersion: process.version,
    nodePath: process.execPath,
    sqliteVersion,
    gitVersion: gitVer,
    gitPath: rt.gitPath,
    gitSource: rt.source,
    dataDir,
    startedAt,
    clients,
  }),
  'project.list': () =>
    (db.prepare('SELECT project_id, display_name, root, entry_files FROM projects ORDER BY created_at').all() as ProjectRow[]).map((r) => ({
      projectId: r.project_id,
      displayName: r.display_name,
      root: r.root,
      entryFiles: JSON.parse(r.entry_files) as string[],
    })),
  'project.status': async (p) => {
    const s = storeFor(p['projectId']);
    const hist = await s.history();
    const pending = db.prepare(`SELECT operation_id, state FROM operations WHERE project_id = ? AND state NOT IN ('completed','failed','denied','expired')`).all(s.cfg.projectId);
    let unsaved: boolean | null = null;
    try {
      const plan = hist[0] ? await s.planRestore(hist[0].meta.snapshotId) : null;
      unsaved = plan ? plan.unsavedChanges : null;
    } catch (e) {
      if (!(e instanceof DtError)) throw e;
    }
    return { projectId: s.cfg.projectId, versions: hist.length, latest: hist[0] ? { snapshotId: hist[0].meta.snapshotId, kind: hist[0].meta.kind, name: hist[0].meta.name ?? null, createdAt: hist[0].meta.createdAt } : null, unsavedChanges: unsaved, pendingOperations: pending };
  },
  'snapshot.create': async (p, caller) => {
    const s = storeFor(p['projectId']);
    const name = typeof p['name'] === 'string' ? p['name'] : undefined;
    const r = await s.snapshot(name ? { kind: kindFor[caller], origin: originFor[caller], name } : { kind: kindFor[caller], origin: originFor[caller] });
    return { snapshotId: r.snapshotId, kind: r.kind, files: r.capture.files, bytes: r.capture.bytes };
  },
  'history.list': async (p) => {
    const hist = await storeFor(p['projectId']).history();
    return hist.map((h, i) => ({ display: `V${hist.length - i}`, snapshotId: h.meta.snapshotId, kind: h.meta.kind, name: h.meta.name ?? null, origin: h.meta.origin, createdAt: h.meta.createdAt, restoreOf: h.meta.restoreOf ?? null }));
  },
  'restore.plan': async (p, caller) => {
    const s = storeFor(p['projectId']);
    if (typeof p['snapshotId'] !== 'string') throw new DtError('PLAN_STALE', 'snapshotId is required');
    const plan = await s.planRestore(p['snapshotId']);
    db.prepare('INSERT INTO operations (operation_id, project_id, kind, state, requested_by, plan, fingerprint, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      plan.planId, s.cfg.projectId, 'restore', 'planned', caller, JSON.stringify(plan), plan.fingerprint, plan.expiresAt, now(), now(),
    );
    return { operationId: plan.planId, state: 'planned', summary: planSummary(plan) };
  },
  'operation.requestApproval': (p, caller) => {
    const row = getOperation(p['operationId']);
    if (row.requested_by !== caller) throw new DtError('APPROVAL_DENIED', 'operation belongs to another caller');
    if (row.state === 'planned') setState(row.operation_id, 'awaiting-approval');
    const view = operationView(getOperation(row.operation_id));
    emitDesktop({ event: 'approval.requested', operation: view });
    throw new DtError('CONFIRMATION_REQUIRED', 'confirm this restore in the Draft Tide app', { operation: view }, true);
  },
  'operation.status': (p) => operationView(getOperation(p['operationId'])),
  'restore.apply': async (p, caller) => {
    // Anything the caller claims (confirmed: true, approvalId, force) is
    // ignored: only a stored, unexpired, unconsumed desktop decision counts.
    const row = getOperation(p['operationId']);
    if (row.requested_by !== caller) throw new DtError('APPROVAL_DENIED', 'operation belongs to another caller');
    const plan = JSON.parse(row.plan) as RestorePlan;
    const consumed = db.transaction(() => {
      const a = db.prepare('SELECT * FROM approvals WHERE operation_id = ?').get(row.operation_id) as { approval_id: string; decision: string; caller: string; fingerprint: string; kind: string; project_id: string; expires_at: string; consumed_at: string | null } | undefined;
      if (!a) throw new DtError('CONFIRMATION_REQUIRED', 'waiting for confirmation in the Draft Tide app', { operationId: row.operation_id }, true);
      if (a.decision !== 'approve') throw new DtError('APPROVAL_DENIED', 'the restore was declined in the Draft Tide app');
      if (a.consumed_at) throw new DtError('APPROVAL_DENIED', 'this confirmation was already used');
      if (Date.parse(a.expires_at) < Date.now()) throw new DtError('PLAN_STALE', 'the confirmation expired; check the restore again');
      if (a.fingerprint !== plan.fingerprint || a.caller !== caller || a.kind !== 'restore' || a.project_id !== row.project_id) throw new DtError('APPROVAL_DENIED', 'confirmation does not match this plan');
      db.prepare('UPDATE approvals SET consumed_at = ? WHERE approval_id = ?').run(now(), a.approval_id);
      db.prepare(`UPDATE operations SET state = 'confirmed', updated_at = ? WHERE operation_id = ?`).run(now(), row.operation_id);
      return true;
    })();
    if (!consumed) throw new DtError('APPROVAL_DENIED', 'not approved');
    setState(row.operation_id, 'applying');
    try {
      const r = await storeFor(row.project_id).applyRestore(plan, originFor[caller]);
      const result = { restoreSnapshotId: r.restoreSnapshotId, protectionSnapshotId: r.protection?.snapshotId ?? null };
      setState(row.operation_id, 'completed', { result });
      emitDesktop({ event: 'operation.completed', operationId: row.operation_id, result });
      return { operationId: row.operation_id, state: 'completed', ...result };
    } catch (e) {
      const err = e instanceof DtError ? { code: e.code, message: e.message } : { code: 'STORAGE_IO_FAILED', message: String(e) };
      setState(row.operation_id, e instanceof DtError && e.code === 'RECOVERY_REQUIRED' ? 'recovery-required' : 'failed', { error: err });
      throw e;
    }
  },
};

// Desktop confirmation channel: binding a folder and deciding approvals.
const desktopOps: Record<string, Handler> = {
  ...toolOps,
  'events.subscribe': () => ({ subscribed: true }),
  'project.bind': async (p) => {
    if (typeof p['root'] !== 'string') throw new DtError('LOCAL_ROOT_UNAVAILABLE', 'root is required');
    const entryFiles = Array.isArray(p['entryFiles']) ? (p['entryFiles'] as string[]) : ['index.html'];
    const existing = db.prepare('SELECT project_id FROM projects WHERE root = ?').get(p['root']) as { project_id: string } | undefined;
    if (existing) return { projectId: existing.project_id, created: false };
    const s = await ProjectStore.create(dataDir, rt, { root: p['root'], entryFiles, policy: DEFAULT_SCOPE_POLICY });
    db.prepare('INSERT INTO projects (project_id, root, display_name, entry_files, policy, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      s.cfg.projectId, p['root'], typeof p['displayName'] === 'string' ? p['displayName'] : basename(p['root']), JSON.stringify(entryFiles), JSON.stringify(DEFAULT_SCOPE_POLICY), now(),
    );
    stores.set(s.cfg.projectId, s);
    const base = await s.snapshot({ kind: 'baseline', origin: 'gui', name: 'First version' });
    return { projectId: s.cfg.projectId, created: true, baselineSnapshotId: base.snapshotId };
  },
  // Materializes one saved version into a read-only cache workspace for the
  // Preview Host. The host gets only this path: no DB, Git or tokens.
  'preview.prepare': async (p) => {
    const s = storeFor(p['projectId']);
    if (typeof p['snapshotId'] !== 'string') throw new DtError('PLAN_STALE', 'snapshotId is required');
    const snap = await s.findSnapshot(p['snapshotId']);
    const workspace = join(s.projectDir, 'cache', 'preview', snap.commit);
    if (!existsSync(workspace)) {
      const tmp = `${workspace}.tmp-${randomUUID()}`;
      await s.materialize(snap.commit, tmp);
      execFileSync('/bin/chmod', ['-R', 'a-w', tmp]);
      renameSync(tmp, workspace);
    }
    return { workspace, entryFiles: snap.meta.entryFiles, snapshotId: snap.meta.snapshotId };
  },
  'approval.list': () => (db.prepare(`SELECT * FROM operations WHERE state = 'awaiting-approval'`).all() as OperationRow[]).map(operationView),
  'approval.decide': (p) => {
    const row = getOperation(p['operationId']);
    if (row.state !== 'awaiting-approval') throw new DtError('PLAN_STALE', 'operation is not waiting for confirmation', { state: row.state });
    const decision = p['decision'] === 'approve' ? 'approve' : 'deny';
    const plan = JSON.parse(row.plan) as RestorePlan;
    db.prepare('INSERT INTO approvals (approval_id, operation_id, decision, caller, project_id, kind, fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(), row.operation_id, decision, row.requested_by, row.project_id, row.kind, plan.fingerprint, new Date(Math.min(Date.parse(plan.expiresAt), Date.now() + 5 * 60_000)).toISOString(), now(),
    );
    setState(row.operation_id, decision === 'approve' ? 'approved' : 'denied');
    return operationView(getOperation(row.operation_id));
  },
};

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer((sock) => {
  let caller: ClientKind | null = null;
  clients++;
  lastActivity = Date.now();
  sock.on('error', () => undefined);
  sock.on('close', () => {
    clients--;
    desktopSockets.delete(sock);
    lastActivity = Date.now();
  });
  readFrames(sock, (raw) => {
    const msg = raw as Request & { protocolVersion?: number; storageSchemaVersion?: number; client?: ClientKind; token?: string };
    const reply = (data: unknown) => writeFrame(sock, { requestId: msg.requestId, ok: true, data });
    const fail = (e: unknown) => {
      const err = e instanceof DtError ? e : new DtError('STORAGE_IO_FAILED', e instanceof Error ? e.message : String(e));
      writeFrame(sock, { requestId: msg.requestId, ok: false, error: { code: err.code, message: err.message, details: err.details, retryable: err.retryable } });
    };
    lastActivity = Date.now();
    if (!caller) {
      if (msg.op !== 'hello') return fail(new DtError('UNAUTHENTICATED', 'hello required'));
      if (msg.protocolVersion !== PROTOCOL_VERSION || msg.storageSchemaVersion !== STORAGE_SCHEMA_VERSION) {
        return fail(new DtError('PROTOCOL_MISMATCH', 'this Draft Tide component needs a different version; update the app', { engineProtocol: PROTOCOL_VERSION, engineStorageSchema: STORAGE_SCHEMA_VERSION }));
      }
      const kind = msg.client;
      const ok = kind === 'desktop' ? tokenOk(msg.token, desktopToken) : (kind === 'cli' || kind === 'mcp' || kind === 'harness') && tokenOk(msg.token, toolToken);
      if (!ok || !kind) {
        fail(new DtError('UNAUTHENTICATED', 'engine handshake failed'));
        sock.end();
        return;
      }
      caller = kind;
      if (kind === 'desktop') desktopSockets.add(sock);
      return reply({ instanceId, protocolVersion: PROTOCOL_VERSION, capabilities: Object.keys(kind === 'desktop' ? desktopOps : toolOps) });
    }
    const table = caller === 'desktop' ? desktopOps : toolOps;
    const handler = table[msg.op];
    if (!handler) return fail(new DtError('UNKNOWN_OPERATION', `operation not available on this channel: ${String(msg.op).slice(0, 64)}`));
    activeOps++;
    Promise.resolve()
      .then(() => handler((msg.payload ?? {}) as Record<string, unknown>, caller as ClientKind))
      .then(reply, fail)
      .finally(() => {
        activeOps--;
        lastActivity = Date.now();
      });
  });
});

server.listen(paths.socket, () => {
  chmodSync(paths.socket, 0o600);
  writeAtomic(paths.discovery, JSON.stringify({ pid: process.pid, instanceId, protocolVersion: PROTOCOL_VERSION, storageSchemaVersion: STORAGE_SCHEMA_VERSION, socket: paths.socket, token: toolToken, startedAt }));
  log(`ready instance=${instanceId} node=${process.version} sqlite=${sqliteVersion} ${gitVer} (${rt.source}) socket=${paths.socket}`);
});

function shutdown(reason: string): void {
  log(`shutting down: ${reason}`);
  server.close();
  try {
    const d = JSON.parse(readFileSync(paths.discovery, 'utf8')) as { instanceId: string };
    if (d.instanceId === instanceId) {
      rmSync(paths.discovery, { force: true });
      rmSync(paths.desktopToken, { force: true });
    }
  } catch {
    // discovery already gone
  }
  rmSync(paths.socket, { force: true });
  db.close();
  lockDb.close();
  process.exit(0);
}
setInterval(() => {
  if (clients === 0 && activeOps === 0 && Date.now() - lastActivity > IDLE_MS) shutdown('idle');
}, 500).unref();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
