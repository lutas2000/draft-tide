import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  EngineEvent,
  FileDiff,
  FolderReview,
  HistoryEntry,
  OPERATIONS,
  ProjectStatus,
  VersionRef,
  isOfferedOn,
} from '../src/index.ts';

const oid = 'a'.repeat(40);

describe('M1-04 operations in the catalog', () => {
  it('keeps connecting a folder to the trusted GUI', () => {
    for (const op of ['project.review', 'project.bind'] as const) {
      expect(isOfferedOn(op, 'desktop')).toBe(true);
      expect(isOfferedOn(op, 'tool')).toBe(false);
    }
  });

  it('offers status, saving, history and comparison to agents only with agent access', () => {
    for (const op of [
      'project.status',
      'snapshot.create',
      'history.list',
      'snapshot.diff',
      'snapshot.diffFile',
    ] as const) {
      expect(OPERATIONS[op].tool).toBe('agent-access');
      expect(OPERATIONS[op].desktop).toBe(true);
    }
    expect(OPERATIONS['snapshot.create'].effect).toBe('write');
    expect(OPERATIONS['project.bind'].effect).toBe('write');
    // Nothing in M1-04 overwrites or deletes working files.
    const effects: string[] = Object.values(OPERATIONS).map((s) => s.effect);
    expect(effects).not.toContain('destructive');
  });

  it('refuses self-asserted flags and unknown fields', () => {
    const projectId = randomUUID();
    expect(OPERATIONS['snapshot.create'].input.safeParse({ projectId, force: true }).success).toBe(false);
    expect(
      OPERATIONS['project.bind'].input.safeParse({
        root: '/x',
        name: 'n',
        entryFiles: [],
        reviewToken: 'f'.repeat(64),
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(OPERATIONS['history.list'].input.safeParse({ projectId, limit: 201 }).success).toBe(false);
    expect(OPERATIONS['history.list'].input.safeParse({ projectId, skip: -1 }).success).toBe(false);
  });

  it('accepts only safe entry pages and single-line names when binding', () => {
    const base = { root: '/x', name: 'Landing', entryFiles: ['index.html'], reviewToken: 'f'.repeat(64) };
    const bind = OPERATIONS['project.bind'].input;
    expect(bind.safeParse(base).success).toBe(true);
    expect(bind.safeParse({ ...base, entryFiles: ['../outside.html'] }).success).toBe(false);
    expect(bind.safeParse({ ...base, entryFiles: ['/abs.html'] }).success).toBe(false);
    expect(bind.safeParse({ ...base, name: 'two\nlines' }).success).toBe(false);
    expect(bind.safeParse({ ...base, root: 'a\u001b[31m' }).success).toBe(false);
  });

  it('adds the M1-04 error codes', () => {
    expect(ERROR_CATALOG.PROJECT_ALREADY_BOUND.retryable).toBe(false);
    expect(ERROR_CATALOG.SNAPSHOT_NOT_FOUND.retryable).toBe(false);
  });
});

describe('version references', () => {
  it('are a snapshot id or a full commit id, never a revision expression', () => {
    expect(VersionRef.safeParse(randomUUID()).success).toBe(true);
    expect(VersionRef.safeParse(oid).success).toBe(true);
    for (const bad of ['HEAD', 'HEAD~1', 'main', oid.slice(0, 7), `${oid}^`, 'A'.repeat(40), `--${oid}`]) {
      expect(VersionRef.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('DTOs', () => {
  const entry = {
    commit: oid,
    parents: [],
    title: 'Baseline',
    source: 'draft-tide',
    snapshot: {
      snapshotId: randomUUID(),
      kind: 'baseline',
      name: null,
      createdAt: '2026-10-02T08:30:00.123Z',
      origin: 'gui',
      restoreOf: null,
    },
    unreadable: null,
    copyOf: null,
    seq: 1,
    authorName: 'Draft Tide',
    committedAt: '2026-10-02T08:30:00.000Z',
  };

  it('keep history entries strict', () => {
    expect(HistoryEntry.parse(entry)).toEqual(entry);
    expect(HistoryEntry.safeParse({ ...entry, authorEmail: 'me@example.com' }).success).toBe(false);
    expect(HistoryEntry.safeParse({ ...entry, source: 'mine' }).success).toBe(false);
  });

  it('carry a file diff either as lines or as a summary with a stable reason', () => {
    const file = { mode: '100644', oid, size: 3 };
    expect(
      FileDiff.safeParse({ kind: 'summary', path: 'a.png', before: file, after: null, reason: 'binary' }).success,
    ).toBe(true);
    expect(
      FileDiff.safeParse({ kind: 'summary', path: 'a.png', before: file, after: null, reason: 'huge' }).success,
    ).toBe(false);
    expect(
      FileDiff.safeParse({
        kind: 'text',
        path: 'a.txt',
        before: file,
        after: file,
        added: 1,
        removed: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }],
        truncated: false,
        lineEndings: { before: 'lf', after: 'crlf' },
        missingFinalNewline: { before: false, after: true },
      }).success,
    ).toBe(true);
  });

  it('carry progress and outcomes as events, without file names', () => {
    const ids = { operationId: randomUUID(), projectId: randomUUID() };
    const progress = { stage: 'hash', attempt: 1, filesDone: 1, filesTotal: 2, bytesDone: 10, bytesTotal: 20 };
    expect(
      EngineEvent.safeParse({
        name: 'operation.progress',
        ...ids,
        operation: 'snapshot.create',
        origin: 'cli',
        progress,
      }).success,
    ).toBe(true);
    expect(
      EngineEvent.safeParse({
        name: 'operation.progress',
        ...ids,
        operation: 'snapshot.create',
        origin: 'cli',
        progress: { ...progress, path: 'secret.txt' },
      }).success,
    ).toBe(false);
    expect(
      EngineEvent.safeParse({
        name: 'operation.settled',
        ...ids,
        operation: 'snapshot.create',
        origin: 'gui',
        outcome: 'no-changes',
        code: 'NO_CHANGES',
      }).success,
    ).toBe(true);
    expect(EngineEvent.safeParse({ name: 'project.changed', projectId: ids.projectId, reason: 'saved' }).success).toBe(
      true,
    );
  });

  it('describe the folder and status strictly', () => {
    expect(FolderReview.safeParse({}).success).toBe(false);
    expect(ProjectStatus.safeParse({}).success).toBe(false);
  });
});
