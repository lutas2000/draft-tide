import {
  DtError,
  OPERATIONS,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  isOfferedOn,
  isToolChannel,
  type Channel,
  type OperationName,
  type OperationOutput,
  type OperationParsedInput,
} from '@draft-tide/contracts';
import { authorize } from './policy.ts';
import type { CorePorts } from './ports.ts';

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
}

export function createEngineCore(ports: CorePorts): EngineCore {
  const { clock, store, events, identity } = ports;

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
  };
}
