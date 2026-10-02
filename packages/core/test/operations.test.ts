import { randomUUID } from 'node:crypto';
import {
  DtError,
  MAX_PENDING_REQUESTS,
  OPERATION_STATES,
  OperationId,
  OperationStatus,
  ProjectId,
  TERMINAL_OPERATION_STATES,
  type EngineEvent,
} from '@draft-tide/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canMove,
  createOperationService,
  createProjectContext,
  findCollisions,
  operationStatusOf,
  plannedChanges,
  restorableFiles,
  type GitTreeEntry,
  type ProjectHost,
  type RestoreFile,
} from '../src/index.ts';
import { memoryStore } from './memory-store.ts';
import { World, oidOf } from './world.ts';

// The journal's state machine, the pure parts of a restore plan, and the
// operations every channel can follow (status, cancel, requests). Restores on
// real Git, files and SQLite are in the companion's integration tests.

const noHost = {} as ProjectHost;

function setup() {
  const store = memoryStore();
  const events: EngineEvent[] = [];
  const ctx = createProjectContext({
    store,
    host: noHost,
    clock: { nowIso: () => new Date().toISOString() },
    events: { publish: (e) => events.push(e) },
  });
  return { store, events, ctx, ops: createOperationService(ctx) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof DtError ? e.code : 'thrown';
  }
}

describe('the journal state machine', () => {
  it('never leaves a terminal state, and never goes back to planned', () => {
    for (const from of OPERATION_STATES) {
      for (const to of OPERATION_STATES) {
        if (TERMINAL_OPERATION_STATES.has(from)) expect(canMove(from, to), `${from}→${to}`).toBe(false);
        if (to === 'planned') expect(canMove(from, to)).toBe(false);
      }
    }
  });

  it('fails an operation only before a file is written', () => {
    for (const s of ['confirmed', 'preflight', 'protected', 'staged', 'applying'] as const) {
      expect(canMove(s, 'failed')).toBe(true);
    }
    expect(canMove('verified', 'failed')).toBe(false);
    expect(canMove('applying', 'cancelled')).toBe(false);
    expect(canMove('verified', 'recovery-required')).toBe(true);
    expect(canMove('recovery-required', 'rolled-back')).toBe(true);
    expect(canMove('awaiting-user', 'denied')).toBe(true);
    expect(canMove('awaiting-user', 'failed')).toBe(false);
  });
});

describe('what a restore would change', () => {
  const file = (path: string, content: string, mode: '100644' | '100755' = '100644'): RestoreFile => ({
    path,
    mode,
    oid: oidOf(Buffer.from(content)),
    size: content.length,
  });

  it('overwrites, adds and deletes against the folder, and leaves equal files alone', () => {
    const live = [file('a.html', 'same'), file('b.html', 'old'), file('gone.css', 'x'), file('run.sh', 'sh')];
    const restore = [
      file('a.html', 'same'),
      file('b.html', 'new'),
      file('new.png', 'png'),
      file('run.sh', 'sh', '100755'),
    ];
    const c = plannedChanges(live, restore);
    expect(c.unchanged).toBe(1);
    expect(c.writes.map((w) => [w.path, w.before === null ? 'add' : 'overwrite'])).toEqual([
      ['b.html', 'overwrite'],
      ['new.png', 'add'],
      ['run.sh', 'overwrite'],
    ]);
    expect(c.deletes.map((d) => d.path)).toEqual(['gone.css']);
  });

  it('touches nothing when the folder already equals the version (property)', () => {
    const name = fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,2}\.(html|css)$/);
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(name, fc.string()), { selector: ([p]) => p, maxLength: 20 }), (entries) => {
        const files = entries.map(([p, c]) => file(p, c));
        const c = plannedChanges(files, files);
        return c.writes.length === 0 && c.deletes.length === 0 && c.unchanged === files.length;
      }),
    );
  });

  it('refuses a version a folder cannot hold, naming every item', () => {
    const entry = (path: string, mode: string, type: 'blob' | 'commit' = 'blob'): GitTreeEntry => ({
      path,
      mode,
      type,
      oid: 'a'.repeat(40),
      size: type === 'blob' ? 1 : null,
    });
    const err = (() => {
      try {
        restorableFiles({
          entries: [
            entry('ok.html', '100644'),
            entry('link', '120000'),
            entry('sub', '160000', 'commit'),
            entry('Page.html', '100644'),
            entry('page.html', '100644'),
          ],
          nonUtf8: ['bad\uFFFD'],
        });
      } catch (e) {
        return e as DtError;
      }
      throw new Error('expected a refusal');
    })();
    expect(err).toMatchObject({ code: 'UNSUPPORTED_ENTRY', details: { reason: 'version-not-restorable', count: 5 } });
    expect(err.details['entries']).toEqual([
      { path: 'Page.html', kind: 'path-collision' },
      { path: 'bad\uFFFD', kind: 'non-utf8-name' },
      { path: 'link', kind: 'symlink' },
      { path: 'page.html', kind: 'path-collision' },
      { path: 'sub', kind: 'special' },
    ]);
  });

  it('finds what no version holds in the way, but not files the restore deletes first', async () => {
    const w = new World();
    w.write('index.html', 'saved');
    w.write('cache/tmp.txt', 'ignored, unsaved');
    w.write('Readme.md', 'saved, deleted first');
    w.write('folder/inner.txt', 'ignored');
    const ws = w.workspace();
    const at = (path: string, before: string | null) => ({
      path,
      before: before === null ? null : { oid: oidOf(Buffer.from(before)), mode: '100644' as const },
      after: { oid: 'b'.repeat(40), mode: '100644' as const },
      size: 1,
    });
    const collisions = await findCollisions(ws, {
      writes: [
        at('index.html', 'saved'),
        at('cache/tmp.txt', null),
        at('README.md', null),
        at('folder', null),
        at('cache/tmp.txt/x', null),
      ],
      deletes: [{ path: 'Readme.md', before: { oid: oidOf(Buffer.from('saved, deleted first')), mode: '100644' } }],
      unchanged: 0,
    });
    expect(collisions).toEqual([
      { path: 'cache/tmp.txt', reason: 'unsaved-file' },
      { path: 'cache/tmp.txt/x', reason: 'parent' },
      { path: 'folder', reason: 'folder' },
    ]);
  });
});

describe('operations every channel can follow', () => {
  it('records a request to connect a folder and always answers CONFIRMATION_REQUIRED', () => {
    const { ops, store, events } = setup();
    let id = '';
    try {
      ops.requestConnect({ root: '/Users/me/design', name: ' Pricing ', entryFiles: ['a.html', 'a.html'] }, 'mcp');
    } catch (e) {
      expect(e).toMatchObject({ code: 'CONFIRMATION_REQUIRED', details: { operation: 'project.connect' } });
      id = (e as DtError).details['operationId'] as string;
    }
    expect(ops.status(OperationId.parse(id))).toMatchObject({
      kind: 'connect-request',
      state: 'awaiting-user',
      origin: 'mcp',
      request: { root: '/Users/me/design', name: 'Pricing', entryFiles: ['a.html'] },
      project: null,
    });
    expect(events).toEqual([{ name: 'operations.changed' }]);
    expect(store.operations.size).toBe(1);
    expect(codeOf(() => ops.requestConnect({ root: 'design' }, 'cli'))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => ops.requestConnect({ root: 'C:\\Users\\me' }, 'cli'))).toBe('CONFIRMATION_REQUIRED');
  });

  it('lets the user decline, the requester withdraw, and a bind complete a request, once', () => {
    const { ops } = setup();
    const ask = () => {
      try {
        ops.requestConnect({ root: '/x' }, 'cli');
      } catch (e) {
        return OperationId.parse((e as DtError).details['operationId']);
      }
      throw new Error('expected CONFIRMATION_REQUIRED');
    };
    const a = ask();
    expect(ops.decline(a)).toMatchObject({ state: 'denied', error: { code: 'APPROVAL_DENIED' } });
    expect(ops.cancel(a)).toMatchObject({ outcome: 'ended', operation: { state: 'denied' } });
    const b = ask();
    expect(ops.cancel(b)).toMatchObject({ outcome: 'cancelled', operation: { state: 'cancelled' } });
    expect(ops.decline(b).state).toBe('cancelled');
    const c = ask();
    const project = {
      projectId: ProjectId.parse(randomUUID()),
      name: 'P',
      root: '/x',
      boundAt: new Date().toISOString(),
    };
    ops.completeRequest(c, project);
    expect(ops.status(c)).toMatchObject({ state: 'completed', project: { projectId: project.projectId } });
    expect(ops.list().requests).toEqual([]);
  });

  it('keeps the number of waiting requests bounded', () => {
    const { ops } = setup();
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) codeOf(() => ops.requestConnect({ root: `/r${i}` }, 'cli'));
    expect(codeOf(() => ops.requestConnect({ root: '/one-more' }, 'cli'))).toBe('RESOURCE_BUDGET_EXCEEDED');
  });

  it('answers unknown ids, and cancels nothing that has ended', () => {
    const { ops, store } = setup();
    expect(codeOf(() => ops.status(OperationId.parse(randomUUID())))).toBe('INVALID_ARGUMENT');
    const operationId = OperationId.parse(randomUUID());
    const at = new Date().toISOString();
    store.insertOperation({
      operationId,
      projectId: ProjectId.parse(randomUUID()),
      kind: 'save',
      origin: 'gui',
      state: 'recovery-required',
      createdAt: at,
      updatedAt: at,
      acknowledged: false,
      journal: { kind: 'save', publish: null, snapshot: null, error: null },
    } as never);
    // Stopped part-way: cancelling can't undo written files.
    expect(ops.cancel(operationId).outcome).toBe('too-late');
    expect(codeOf(() => ops.decline(operationId))).toBe('INVALID_ARGUMENT');
  });

  it('lists agent restores as notices until dismissed, and what needs recovery', () => {
    const { ops, store } = setup();
    const at = new Date().toISOString();
    const restore = (origin: 'gui' | 'cli', state: 'completed' | 'recovery-required') => {
      const operationId = OperationId.parse(randomUUID());
      store.insertOperation({
        operationId,
        projectId: ProjectId.parse(randomUUID()),
        kind: 'restore',
        origin,
        state,
        createdAt: at,
        updatedAt: at,
        acknowledged: false,
        journal: {
          kind: 'restore',
          planId: randomUUID(),
          ref: 'refs/heads/main',
          baseTip: 'a'.repeat(40),
          target: { commit: 'b'.repeat(40), snapshotId: null },
          targetTree: 'c'.repeat(40),
          settingsBlob: null,
          restoreTree: null,
          protection: null,
          parent: null,
          publish: null,
          restored: null,
          reason: null,
          conflicts: { count: 0, sample: [] },
          error: null,
        },
      } as never);
      return operationId;
    };
    restore('gui', 'completed');
    const agent = restore('cli', 'completed');
    const stuck = restore('cli', 'recovery-required');
    const list = ops.list();
    expect(list.notices.map((n) => n.operationId).sort()).toEqual([agent, stuck].sort());
    expect(list.attention.map((n) => n.operationId)).toEqual([stuck]);
    ops.dismiss(agent);
    expect(ops.list().notices.map((n) => n.operationId)).toEqual([stuck]);
    for (const n of list.notices) expect(OperationStatus.safeParse(n).success).toBe(true);
  });

  it('never passes on a record that breaks the contract', () => {
    const at = new Date().toISOString();
    expect(() =>
      operationStatusOf({
        operationId: OperationId.parse(randomUUID()),
        projectId: null,
        kind: 'save',
        origin: 'gui',
        state: 'completed',
        createdAt: at,
        updatedAt: 'yesterday',
        acknowledged: false,
        journal: { kind: 'save', publish: null, snapshot: null, error: null },
      }),
    ).toThrow(/could not be read/);
  });
});
