import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  EngineEvent,
  OPERATIONS,
  OperationJournal,
  OperationStatus,
  PlanRecord,
  RecoveryResult,
  exitCodeFor,
  isMcpError,
  isNoopCode,
  isOfferedOn,
  type OperationName,
} from '../src/index.ts';

// M1-05's operations, inputs and events as the catalog and schemas define them.

const oid = (c: string) => c.repeat(40);

describe('M1-05 operations in the catalog', () => {
  it('lets agents restore and recover only with agent access, and says those applies are destructive', () => {
    const agentOps: OperationName[] = [
      'restore.plan',
      'restore.apply',
      'recovery.inspect',
      'recovery.plan',
      'recovery.apply',
      'operation.status',
      'operation.cancel',
    ];
    for (const op of agentOps) {
      expect(OPERATIONS[op].tool, op).toBe('agent-access');
      expect(OPERATIONS[op].desktop, op).toBe(true);
    }
    expect(OPERATIONS['restore.apply'].effect).toBe('destructive');
    expect(OPERATIONS['recovery.apply'].effect).toBe('destructive');
    expect(OPERATIONS['restore.plan'].effect).toBe('read');
    expect(OPERATIONS['recovery.plan'].effect).toBe('read');
  });

  it('lets the tool channel only ask to connect a folder, and keeps the answers in the app', () => {
    expect(isOfferedOn('project.connectRequest', 'tool')).toBe(true);
    expect(isOfferedOn('project.connectRequest', 'desktop')).toBe(false);
    for (const op of ['operation.list', 'request.decline', 'operation.dismiss', 'project.bind'] as const) {
      expect(isOfferedOn(op, 'tool'), op).toBe(false);
      expect(isOfferedOn(op, 'desktop'), op).toBe(true);
    }
    // The request never returns data: its answer is CONFIRMATION_REQUIRED.
    expect(OPERATIONS['project.connectRequest'].output.safeParse({}).success).toBe(false);
  });

  it('refuses self-asserted flags, revision expressions and unknown strategies', () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    const input = (op: OperationName, v: unknown) => OPERATIONS[op].input.safeParse(v).success;
    expect(input('restore.apply', { projectId, planId })).toBe(true);
    expect(input('restore.apply', { projectId, planId, confirmed: true })).toBe(false);
    expect(input('restore.apply', { projectId, planId, force: true })).toBe(false);
    expect(input('restore.apply', { projectId, planId: 'latest' })).toBe(false);
    expect(input('restore.plan', { projectId, target: 'HEAD~1' })).toBe(false);
    expect(input('restore.plan', { projectId, target: oid('a') })).toBe(true);
    expect(input('recovery.plan', { projectId, operationId: randomUUID(), strategy: 'finish' })).toBe(true);
    expect(input('recovery.plan', { projectId, operationId: randomUUID(), strategy: 'force' })).toBe(false);
    expect(input('project.connectRequest', { root: '/x', entryFiles: ['../up.html'] })).toBe(false);
    expect(input('project.connectRequest', { root: '/x\n/y' })).toBe(false);
    expect(input('project.connectRequest', { root: '/x', yes: true })).toBe(false);
    expect(
      input('project.bind', { root: '/x', name: 'n', entryFiles: [], reviewToken: 'f'.repeat(64), requestId: 'r' }),
    ).toBe(false);
  });

  it('reports a cancel as a plain failure, not a no-op', () => {
    expect(ERROR_CATALOG.CANCELLED.retryable).toBe(false);
    expect(isNoopCode('CANCELLED')).toBe(false);
    const envelope = { ok: false, error: { code: 'CANCELLED' as const, message: '', details: {}, retryable: false } };
    expect(exitCodeFor(envelope)).toBe(1);
    expect(isMcpError(envelope)).toBe(true);
  });
});

describe('operation records', () => {
  const at = new Date().toISOString();
  const base = {
    operationId: randomUUID(),
    projectId: randomUUID(),
    origin: 'cli',
    createdAt: at,
    updatedAt: at,
    error: null,
  };

  it('describes saves, restores and requests', () => {
    expect(
      OperationStatus.safeParse({
        kind: 'save',
        ...base,
        state: 'completed',
        snapshot: { commit: oid('a'), snapshotId: null },
      }).success,
    ).toBe(true);
    expect(
      OperationStatus.safeParse({
        kind: 'restore',
        ...base,
        state: 'recovery-required',
        target: { commit: oid('a'), snapshotId: randomUUID() },
        protection: null,
        restored: null,
        conflicts: { count: 1, sample: ['index.html'] },
      }).success,
    ).toBe(true);
    expect(
      OperationStatus.safeParse({
        kind: 'connect-request',
        ...base,
        projectId: null,
        state: 'awaiting-user',
        request: { root: '/Users/me/design', name: null, entryFiles: [] },
        project: null,
      }).success,
    ).toBe(true);
    expect(
      RecoveryResult.safeParse({ operation: null, written: 0, deleted: 0, conflicts: { count: 0, sample: [] } })
        .success,
    ).toBe(true);
  });

  it('stores journals and plans strictly', () => {
    const journal = {
      kind: 'save',
      publish: {
        step: 'final',
        ref: 'refs/heads/main',
        expectedOld: null,
        commit: oid('a'),
        tree: oid('b'),
        snapshotId: null,
      },
      snapshot: null,
      error: null,
    };
    expect(OperationJournal.safeParse(journal).success).toBe(true);
    expect(OperationJournal.safeParse({ ...journal, extra: 1 }).success).toBe(false);
    expect(PlanRecord.safeParse({ kind: 'recovery', operationId: randomUUID(), strategy: 'rollback' }).success).toBe(
      true,
    );
    expect(PlanRecord.safeParse({ kind: 'recovery', operationId: randomUUID(), strategy: 'guess' }).success).toBe(
      false,
    );
  });
});

describe('M1-05 events', () => {
  const progress = (p: unknown, operation = 'restore.apply') =>
    EngineEvent.safeParse({
      name: 'operation.progress',
      operationId: randomUUID(),
      projectId: randomUUID(),
      operation,
      origin: 'gui',
      progress: p,
    }).success;

  it('reports restore progress without file names', () => {
    expect(progress({ stage: 'apply', filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 })).toBe(true);
    expect(
      progress({ stage: 'apply', filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30, path: 'a.html' }),
    ).toBe(false);
    expect(
      progress(
        { stage: 'hash', attempt: 1, filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 },
        'snapshot.create',
      ),
    ).toBe(true);
  });

  it('says when an operation stopped part-way, and when requests or notices changed', () => {
    const settled = {
      name: 'operation.settled',
      operationId: randomUUID(),
      projectId: randomUUID(),
      operation: 'restore.apply',
      origin: 'mcp',
      outcome: 'recovery-required',
      code: 'RECOVERY_REQUIRED',
    };
    expect(EngineEvent.safeParse(settled).success).toBe(true);
    expect(EngineEvent.safeParse({ name: 'operations.changed' }).success).toBe(true);
    expect(
      EngineEvent.safeParse({ name: 'project.changed', projectId: randomUUID(), reason: 'restored' }).success,
    ).toBe(true);
  });
});
