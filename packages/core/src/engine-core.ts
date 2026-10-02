import {
  DtError,
  OPERATIONS,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  isOfferedOn,
  isToolChannel,
  type Channel,
  type OperationName,
  type Origin,
  type OperationOutput,
  type OperationParsedInput,
} from '@draft-tide/contracts';
import { createAuthService } from './auth.ts';
import { createProjectContext, type ProjectServiceOptions } from './context.ts';
import { createOpenService } from './open.ts';
import { createOperationService } from './operations.ts';
import { authorize } from './policy.ts';
import type { CorePorts } from './ports.ts';
import { createPreviewService, type PreviewOptions } from './preview.ts';
import { createProjectService } from './projects.ts';
import { createPullService } from './pull.ts';
import { createRecoveryService } from './recovery.ts';
import { createRestoreService } from './restore.ts';
import { createSyncService } from './sync.ts';

interface CallContext {
  channel: Channel;
}

type Handlers = {
  [N in OperationName]: (
    input: OperationParsedInput<N>,
    ctx: CallContext,
  ) => OperationOutput<N> | Promise<OperationOutput<N>>;
};

export interface EngineCore {
  // Authorizes, validates the input, runs the use case and checks the result
  // against the catalog. Throws DtError; anything else is a bug.
  handle(channel: Channel, op: string, payload: unknown): Promise<unknown>;
  // Operations a session on this channel may call, before agent-access checks.
  operationsFor(channel: Channel): OperationName[];
  // At Engine start, before requests: completes what unfinished operations
  // left that needs no decision (M1 plan §9.4), forgets old records, and
  // starts the push queue.
  startup(): Promise<{ recovered: { projectId: string; error: string | null }[] }>;
  // Background work is running or due soon (a push): stay up.
  busy(): boolean;
  // Engine shutdown: stops timers and waiting logins.
  stop(): void;
}

// Ended operations and unused plans are kept this long, for status and
// notices; unfinished ones are never removed.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ORIGIN: Record<Channel, Origin> = { desktop: 'gui', cli: 'cli', mcp: 'mcp' };

export function createEngineCore(
  ports: CorePorts,
  projectOptions: Omit<ProjectServiceOptions, 'store' | 'host' | 'clock' | 'events'> & {
    previews?: PreviewOptions;
  } = {},
): EngineCore {
  const { clock, store, events, identity, host } = ports;
  const { previews: previewOptions, ...contextOptions } = projectOptions;
  const ctx = createProjectContext({ ...contextOptions, store, host, clock, events, remote: ports.remote });
  const recovery = createRecoveryService(ctx);
  const projects = createProjectService(ctx, recovery);
  const restore = createRestoreService(ctx, recovery);
  const operations = createOperationService(ctx);
  const previews = createPreviewService(ctx, ports.previews, previewOptions);
  const sync = createSyncService(ctx);
  const pull = createPullService(ctx, recovery, sync);
  const open = createOpenService(ctx);
  const auth = createAuthService(ctx, {
    onSignedIn(user) {
      operations.completeLoginRequests(user);
      // Pushes that waited for a sign-in.
      sync.resume();
    },
  });

  const handlers: Handlers = {
    'engine.info': (_input, ctx) => ({
      instanceId: identity.instanceId,
      appVersion: identity.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      storageSchemaVersion: store.storageSchemaVersion,
      startedAt: identity.startedAt,
      runtime: { ...identity.runtime, sqlite: store.sqliteVersion },
      desktopIdentity: identity.desktopIdentity,
      agentAccess: { enabled: store.getAgentAccess().enabled },
      channel: ctx.channel,
    }),
    'project.list': () => store.listProjects(),
    'project.review': (input) => projects.review(input.root),
    'project.bind': async (input) => {
      const result = await projects.bind(input);
      if (input.requestId) operations.completeRequest(input.requestId, result.project);
      return result;
    },
    'project.status': (input) => projects.status(input.projectId),
    'project.restoreSettings': (input) => projects.restoreSettings(input.projectId),
    'snapshot.create': async (input, ctx) => {
      const saved = await projects.save(input.projectId, input.name, ORIGIN[ctx.channel]);
      // The history card's thumbnail is made after the save, never as part
      // of it (M1 plan §7.1 step 9). So is the push of a connected project.
      previews.warm(saved.projectId, saved.snapshotId);
      sync.queue(saved.projectId);
      return saved;
    },
    'history.list': (input) => projects.history(input.projectId, { skip: input.skip ?? 0, limit: input.limit ?? 50 }),
    'snapshot.diff': (input) => projects.diff(input.projectId, input.from, input.to),
    'snapshot.diffFile': (input) => projects.diffFile(input.projectId, input.from, input.to, input.path),
    'restore.plan': (input) => restore.plan(input.projectId, input.target),
    'restore.apply': async (input, ctx) => {
      try {
        const result = await restore.apply(input.projectId, input.planId, ORIGIN[ctx.channel]);
        previews.warm(input.projectId, result.restored.snapshotId ?? result.restored.commit);
        return result;
      } finally {
        // Even a restore that stopped may have recorded its protection
        // version.
        sync.queue(input.projectId);
      }
    },
    'recovery.inspect': (input) => recovery.inspect(input.projectId),
    'recovery.plan': (input) => recovery.plan(input.projectId, input.operationId, input.strategy),
    'recovery.apply': async (input, ctx) => {
      try {
        return await recovery.apply(input.projectId, input.planId, ORIGIN[ctx.channel]);
      } finally {
        sync.queue(input.projectId);
      }
    },
    'snapshot.preview': (input) => previews.preview(input.projectId, input.version, input.file),
    'preview.read': (input) => previews.read(input.projectId, input.artifactId, input.image, input.offset ?? 0),
    'preview.status': () => previews.status(),
    'preview.clearCache': () => previews.clearCache(),
    'operation.status': (input) => operations.status(input.operationId),
    'operation.cancel': (input) => operations.cancel(input.operationId),
    'project.connectRequest': (input, ctx) => operations.requestConnect(input, ORIGIN[ctx.channel]),
    'operation.list': () => operations.list(),
    'request.decline': (input) => operations.decline(input.operationId),
    'operation.dismiss': (input) => operations.dismiss(input.operationId),
    'auth.status': (_input, ctx) => auth.status(isToolChannel(ctx.channel)),
    'auth.loginStart': () => auth.loginStart(),
    'auth.loginCancel': () => auth.loginCancel(),
    'auth.logout': () => auth.logout(),
    'auth.loginRequest': async (_input, ctx) => {
      if ((await auth.signedInUser()) !== null) {
        throw new DtError('INVALID_ARGUMENT', 'Draft Tide is already signed in to GitHub (see auth.status)', {
          reason: 'already-signed-in',
        });
      }
      return operations.requestLogin(ORIGIN[ctx.channel]);
    },
    'remote.repos': () => sync.repos(),
    'remote.status': (input) => sync.status(input.projectId, input.refresh ?? false),
    'remote.connectPlan': (input) => sync.connectPlan(input.projectId, input.repo),
    'remote.connectApply': async (input) => {
      const result = await sync.connectApply(input.projectId, input.planId, input.setOrigin);
      operations.completeRemoteConnectRequests(input.projectId, result.remote);
      return result;
    },
    'remote.connectRequest': (input, ctx) => operations.requestRemoteConnect(input.projectId, ORIGIN[ctx.channel]),
    'remote.disconnect': (input) => sync.disconnect(input.projectId),
    'sync.push': (input, ctx) => sync.push(input.projectId, ORIGIN[ctx.channel]),
    'sync.pullPlan': (input) => pull.plan(input.projectId),
    'sync.pullApply': async (input, ctx) => {
      const result = await pull.apply(input.projectId, input.planId, ORIGIN[ctx.channel]);
      previews.warm(input.projectId, result.to.snapshotId ?? result.to.commit);
      return result;
    },
    'remote.openPlan': (input) => open.plan(input.repo, input.destination),
    'remote.openApply': async (input, ctx) => {
      const result = await open.apply(input.planId, ORIGIN[ctx.channel]);
      previews.warm(result.project.projectId, result.tip.snapshotId ?? result.tip.commit);
      return result;
    },
    'agentAccess.get': () => store.getAgentAccess(),
    'agentAccess.set': (input) => {
      const current = store.getAgentAccess();
      if (current.enabled === input.enabled) return current;
      const next = store.setAgentAccess(input.enabled, clock.nowIso());
      events.publish({ name: 'agentAccess.changed', agentAccess: next });
      return next;
    },
  };

  async function run<N extends OperationName>(op: N, payload: unknown, ctx: CallContext): Promise<unknown> {
    const spec = OPERATIONS[op];
    const parsed = spec.input.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new DtError('INVALID_ARGUMENT', `invalid input for ${op}`, {
        issues: parsed.error.issues
          .slice(0, 10)
          .map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      });
    }
    const handler = handlers[op] as (input: unknown, ctx: CallContext) => unknown;
    const result = await handler(parsed.data, ctx);
    // A result that breaks its own contract (an extra field, a malformed id)
    // never leaves the Engine.
    const checked = spec.output.safeParse(result);
    if (!checked.success) throw new DtError('INTERNAL_ERROR', `${op} produced a result outside its contract`);
    return checked.data;
  }

  return {
    async handle(channel, op, payload) {
      const name = authorize(op, channel, isToolChannel(channel) ? store.getAgentAccess().enabled : true);
      return run(name, payload, { channel });
    },
    operationsFor(channel) {
      return OPERATION_NAMES.filter((n) => isOfferedOn(n, isToolChannel(channel) ? 'tool' : 'desktop'));
    },
    async startup() {
      const recovered = await recovery.recoverAll();
      store.prune(new Date(Date.parse(clock.nowIso()) - RETENTION_MS).toISOString());
      await previews.sweep().catch(() => undefined);
      sync.start();
      return { recovered };
    },
    busy: () => sync.busy(),
    stop() {
      sync.stop();
      auth.stop();
    },
  };
}
