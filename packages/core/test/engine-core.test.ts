import { randomUUID } from 'node:crypto';
import {
  CHANNELS,
  DtError,
  EngineInstanceId,
  OPERATION_NAMES,
  OPERATIONS,
  ProjectId,
  type AgentAccess,
  type Channel,
  type EngineEvent,
} from '@draft-tide/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { authorize, createEngineCore, type ProjectHost } from '../src/index.ts';
import { memoryStore } from './memory-store.ts';

// No folder is ever opened by these tests.
const noHost: ProjectHost = {
  canonicalRoot: () => Promise.reject(new DtError('LOCAL_ROOT_UNAVAILABLE', 'no folders here')),
  openRepo: () => {
    throw new Error('not used');
  },
  openListingRepo: () => Promise.reject(new Error('not used')),
  openWorkspace: () => {
    throw new Error('not used');
  },
  createStaging: () => Promise.reject(new Error('not used')),
  clearOperationData: () => Promise.resolve(),
};

function setup(projects: unknown[] = []) {
  const store = memoryStore(projects);
  const published: EngineEvent[] = [];
  const core = createEngineCore({
    clock: { nowIso: () => new Date().toISOString() },
    store,
    events: { publish: (e) => published.push(e) },
    identity: {
      instanceId: EngineInstanceId.parse(randomUUID()),
      appVersion: '0.0.0-test',
      startedAt: new Date().toISOString(),
      desktopIdentity: 'development',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    },
    host: noHost,
  });
  return { core, store, published };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof DtError) return e.code;
    throw e;
  }
}

describe('authorize', () => {
  it('follows the agent-access rules for every operation, channel and switch state', () => {
    const op = fc.oneof(fc.constantFrom(...OPERATION_NAMES), fc.string({ maxLength: 20 }));
    fc.assert(
      fc.property(op, fc.constantFrom<Channel>(...CHANNELS), fc.boolean(), (name, channel, enabled) => {
        let outcome: string;
        try {
          authorize(name, channel, enabled);
          outcome = 'ok';
        } catch (e) {
          outcome = (e as DtError).code;
        }
        const spec = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name as keyof typeof OPERATIONS] : null;
        let expected: string;
        if (!spec) expected = 'UNKNOWN_OPERATION';
        else if (channel === 'desktop') expected = spec.desktop ? 'ok' : 'UNKNOWN_OPERATION';
        else if (spec.tool === 'none') expected = 'UNKNOWN_OPERATION';
        else if (spec.tool === 'always') expected = 'ok';
        else expected = enabled ? 'ok' : 'AGENT_ACCESS_DISABLED';
        expect(outcome).toBe(expected);
      }),
    );
  });
});

describe('engine core', () => {
  it('gives the tool channel only engine.info while agent access is off', async () => {
    const { core } = setup();
    for (const channel of ['cli', 'mcp'] as const) {
      expect(await codeOf(core.handle(channel, 'engine.info', {}))).toBe('ok');
      expect(await codeOf(core.handle(channel, 'project.list', {}))).toBe('AGENT_ACCESS_DISABLED');
    }
  });

  it('never lets the tool channel change agent access, whatever it claims', async () => {
    const { core, store } = setup();
    for (const payload of [{ enabled: true }, { enabled: true, confirmed: true }, { enabled: true, force: true }]) {
      expect(await codeOf(core.handle('mcp', 'agentAccess.set', payload))).toBe('UNKNOWN_OPERATION');
    }
    store.access = { enabled: true, updatedAt: null };
    expect(await codeOf(core.handle('cli', 'agentAccess.set', { enabled: false }))).toBe('UNKNOWN_OPERATION');
  });

  it('lets the desktop turn agent access on and off, and announces real changes only', async () => {
    const { core, published } = setup();
    const on = (await core.handle('desktop', 'agentAccess.set', { enabled: true })) as AgentAccess;
    expect(on.enabled).toBe(true);
    expect(await codeOf(core.handle('cli', 'project.list', {}))).toBe('ok');
    await core.handle('desktop', 'agentAccess.set', { enabled: true });
    expect(published).toHaveLength(1);
    await core.handle('desktop', 'agentAccess.set', { enabled: false });
    expect(published.map((e) => e.name === 'agentAccess.changed' && e.agentAccess.enabled)).toEqual([true, false]);
    expect(await codeOf(core.handle('mcp', 'project.list', {}))).toBe('AGENT_ACCESS_DISABLED');
  });

  it('reports the switch and the caller channel in engine.info', async () => {
    const { core, store } = setup();
    store.access = { enabled: true, updatedAt: null };
    expect(await core.handle('mcp', 'engine.info', {})).toMatchObject({
      agentAccess: { enabled: true },
      channel: 'mcp',
    });
  });

  it('rejects malformed input as INVALID_ARGUMENT', async () => {
    const { core } = setup();
    expect(await codeOf(core.handle('desktop', 'agentAccess.set', { enabled: 'yes' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(core.handle('desktop', 'engine.info', { extra: 1 }))).toBe('INVALID_ARGUMENT');
  });

  it('refuses to return a result outside its contract', async () => {
    const leaky = {
      projectId: ProjectId.parse(randomUUID()),
      name: 'x',
      root: '/tmp/x',
      boundAt: new Date().toISOString(),
      githubToken: 'gho_secret',
    };
    const { core, store } = setup([leaky]);
    store.access = { enabled: true, updatedAt: null };
    expect(await codeOf(core.handle('cli', 'project.list', {}))).toBe('INTERNAL_ERROR');
  });

  it('lists per channel what a session may call', () => {
    const { core } = setup();
    expect(core.operationsFor('cli')).toEqual([
      'engine.info',
      'project.list',
      'project.status',
      'project.restoreSettings',
      'snapshot.create',
      'history.list',
      'snapshot.diff',
      'snapshot.diffFile',
      'snapshot.preview',
      'preview.read',
      'restore.plan',
      'restore.apply',
      'recovery.inspect',
      'recovery.plan',
      'recovery.apply',
      'operation.status',
      'operation.cancel',
      'project.connectRequest',
    ]);
    expect(core.operationsFor('desktop')).toEqual(OPERATION_NAMES.filter((n) => n !== 'project.connectRequest'));
  });
});
