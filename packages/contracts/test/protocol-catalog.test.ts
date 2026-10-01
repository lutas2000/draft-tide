import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ClientMessage,
  OPERATIONS,
  ProjectId,
  SnapshotId,
  SnapshotMetadata,
  canonicalJson,
  isOfferedOn,
  isOperationName,
} from '../src/index.ts';
import { publicSchemas } from '../src/json-schema.ts';

describe('ids', () => {
  it('accept randomUUID and refuse other spellings', () => {
    expect(ProjectId.safeParse(randomUUID()).success).toBe(true);
    expect(ProjectId.safeParse(randomUUID().toUpperCase()).success).toBe(false);
    expect(ProjectId.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('protocol messages', () => {
  it('parse a hello', () => {
    const hello = {
      type: 'hello',
      protocolVersion: 1,
      channel: 'cli',
      client: { name: 'draft-tide-cli', version: '0.0.0' },
      toolToken: 'x'.repeat(43),
    };
    expect(ClientMessage.parse(hello)).toEqual(hello);
  });

  it('refuse unknown members at the message level', () => {
    const req = { type: 'request', requestId: randomUUID(), op: 'engine.info', payload: {}, confirmed: true };
    expect(ClientMessage.safeParse(req).success).toBe(false);
  });

  it('refuse a channel the protocol does not know', () => {
    const hello = { type: 'hello', protocolVersion: 1, channel: 'admin', client: { name: 'x', version: '1' } };
    expect(ClientMessage.safeParse(hello).success).toBe(false);
  });
});

describe('operation catalog', () => {
  it('offers only engine.info to the tool channel unconditionally', () => {
    const always = Object.entries(OPERATIONS)
      .filter(([, s]) => s.tool === 'always')
      .map(([n]) => n);
    expect(always).toEqual(['engine.info']);
  });

  it('keeps the agent-access switch off the tool channel', () => {
    expect(isOfferedOn('agentAccess.set', 'tool')).toBe(false);
    expect(isOfferedOn('agentAccess.get', 'tool')).toBe(false);
    expect(isOfferedOn('agentAccess.set', 'desktop')).toBe(true);
  });

  it('does not treat inherited object keys as operations', () => {
    expect(isOperationName('toString')).toBe(false);
    expect(isOperationName('__proto__')).toBe(false);
  });

  it('uses strict inputs, so self-asserted flags are refused', () => {
    expect(OPERATIONS['agentAccess.set'].input.safeParse({ enabled: true, confirmed: true }).success).toBe(false);
    expect(OPERATIONS['project.list'].input.safeParse({ force: true }).success).toBe(false);
  });
});

describe('snapshot metadata', () => {
  it('refuses fields outside the contract', () => {
    const meta = {
      schemaVersion: 1,
      snapshotId: SnapshotId.parse(randomUUID()),
      kind: 'manual',
      createdAt: new Date().toISOString(),
      origin: 'gui',
    };
    expect(SnapshotMetadata.parse(meta)).toEqual(meta);
    expect(SnapshotMetadata.safeParse({ ...meta, root: '/Users/me/design' }).success).toBe(false);
    expect(SnapshotMetadata.safeParse({ ...meta, createdAt: '2026-10-01T10:00:00+08:00' }).success).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('ignores key order and round-trips', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
        expect(JSON.parse(canonicalJson(obj))).toEqual(JSON.parse(JSON.stringify(obj)));
      }),
    );
  });
});

describe('JSON Schema export', () => {
  it('represents every public schema', () => {
    for (const [name, schema] of Object.entries(publicSchemas())) {
      expect(() => z.toJSONSchema(schema, { unrepresentable: 'throw', io: 'input' }), name).not.toThrow();
    }
  });
});
