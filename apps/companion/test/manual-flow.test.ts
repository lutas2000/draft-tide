// The first manual vertical flow (M1-04) through a real Engine, on real Git
// and a real filesystem: review and connect a folder, read its status, save,
// list history and compare, from the desktop channel and the tool channel.
// What the user's own Git sees is checked with plain Git, without Draft
// Tide's hardening (M1 plan §13.1).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DtError,
  EXIT_CODES,
  PROJECT_CONFIG_FILE,
  ProjectConfig,
  type EngineEvent,
  type FolderReview,
  type ProjectBindResult,
  type ProjectId,
} from '@draft-tide/contracts';
import type { EngineConnection } from '@draft-tide/engine-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  committedRepo,
  digestTree,
  gitStatus,
  plainGit,
  tempDir,
  write,
} from '../../../packages/git-backend/test/helpers.ts';
import { CLI_SOURCE, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

const onWindows = process.platform === 'win32';
const dataDir = tempDataDir();
let desktop: EngineConnection;
const events: EngineEvent[] = [];

beforeAll(async () => {
  desktop = await connectTo(dataDir, 'desktop', 5_000);
  desktop.onEvent((e) => events.push(e));
});

afterAll(async () => {
  desktop?.close();
  await cleanupDataDirs();
  cleanupTempDirs();
});

async function refusal(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '5000' },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function cliJson(...args: string[]): { status: number | null; envelope: Record<string, unknown> } {
  const r = cli('--json', ...args);
  return { status: r.status, envelope: JSON.parse(r.stdout) as Record<string, unknown> };
}

const review = (root: string): Promise<FolderReview> => desktop.call('project.review', { root });

async function connect(
  root: string,
  extra: { name?: string; entryFiles?: string[]; asNewProject?: boolean } = {},
): Promise<ProjectBindResult> {
  const r = await review(root);
  return desktop.call('project.bind', {
    root,
    name: extra.name ?? 'Fixture',
    entryFiles: extra.entryFiles ?? [],
    reviewToken: r.reviewToken,
    ...(extra.asNewProject ? { asNewProject: true } : {}),
  });
}

async function connectAndSave(root: string, name = 'Fixture'): Promise<ProjectId> {
  const { project } = await connect(root, { name });
  await desktop.call('snapshot.create', { projectId: project.projectId });
  return project.projectId;
}

function designFolder(): string {
  const root = tempDir('dt-flow-');
  write(root, 'index.html', '<!doctype html>\n<link rel=stylesheet href=css/site.css>\n<h1>Pricing</h1>\n');
  write(root, 'css/site.css', 'body { margin: 0; }\n');
  write(root, 'img/hero.png', randomBytes(4096));
  write(root, '.env', 'API_KEY=secret\n');
  write(root, 'node_modules/lib/index.js', 'module.exports = 1;\n');
  return root;
}

const readConfig = (root: string) =>
  ProjectConfig.parse(JSON.parse(readFileSync(join(root, PROJECT_CONFIG_FILE), 'utf8')));
const commits = (root: string) => Number(plainGit(root, ['rev-list', '--count', 'HEAD']).trim());

describe('connecting a folder', () => {
  it('reviews a plain folder without writing anything, then connects it with git init and a baseline', async () => {
    const root = designFolder();
    const before = digestTree(root);
    const r = await review(root);
    expect(digestTree(root)).toEqual(before);
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(r).toMatchObject({
      root,
      repo: { hasRepo: false, branch: null, tip: null },
      blockers: [],
      scopeListed: true,
      included: { files: 3 },
      unsupported: { count: 0 },
      config: { status: 'missing' },
      binding: { status: 'new' },
      entryCandidates: ['index.html'],
    });
    expect(r.excluded.sample).toEqual(['.env', 'node_modules/']);

    const bound = await desktop.call('project.bind', {
      root,
      name: '定價頁',
      entryFiles: ['index.html'],
      reviewToken: r.reviewToken,
    });
    expect(bound).toMatchObject({
      initialized: true,
      configWritten: true,
      relinked: false,
      project: { name: '定價頁', root },
    });
    expect(readConfig(root)).toMatchObject({
      projectId: bound.project.projectId,
      name: '定價頁',
      entryFiles: ['index.html'],
    });
    expect(plainGit(root, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');

    const saved = await desktop.call('snapshot.create', { projectId: bound.project.projectId });
    expect(saved).toMatchObject({ kind: 'baseline', origin: 'gui', parent: null, branch: 'main', files: 4 });
    // Plain Git agrees: tracked files clean, only the excluded ones untracked.
    expect(plainGit(root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(plainGit(root, ['ls-files']).split('\n').filter(Boolean).sort()).toEqual(
      [PROJECT_CONFIG_FILE, 'css/site.css', 'img/hero.png', 'index.html'].sort(),
    );
    expect((await desktop.call('project.list', {})).map((p) => p.projectId)).toContain(bound.project.projectId);
  });

  it("adopts an existing repo on its branch, building on the user's own commit", async () => {
    const root = committedRepo({ 'index.html': '<h1>v1</h1>\n', 'notes.md': 'hi\n' });
    plainGit(root, ['branch', 'experiment']);
    const userHead = plainGit(root, ['rev-parse', 'HEAD']).trim();
    const r = await review(root);
    expect(r.repo).toMatchObject({ hasRepo: true, branch: 'main', tip: userHead });
    const projectId = await connectAndSave(root);
    const history = await desktop.call('history.list', { projectId });
    expect(history.entries.map((e) => [e.source, e.seq, e.title])).toEqual([
      ['draft-tide', 1, 'Baseline'],
      ['external', null, 'first'],
    ]);
    expect(history.entries[0]?.parents).toEqual([userHead]);
    expect(plainGit(root, ['rev-parse', 'experiment']).trim()).toBe(userHead);
    expect(gitStatus(root)).toBe('');
  });

  it('refuses a repo it cannot use, before writing anything', async () => {
    const root = committedRepo();
    plainGit(root, ['checkout', '--quiet', '--detach']);
    const r = await review(root);
    expect(r.blockers.map((b) => b.reason)).toEqual(['detached-head']);
    expect(r).toMatchObject({ scopeListed: false, included: { files: 0 } });
    const before = digestTree(root);
    const err = await refusal(
      desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: r.reviewToken }),
    );
    expect(err.code).toBe('REPO_UNSUPPORTED');
    expect(digestTree(root)).toEqual(before);
  });

  it.skipIf(onWindows)('refuses a folder with something it cannot save, before writing anything', async () => {
    const root = designFolder();
    symlinkSync('/etc/hosts', join(root, 'hosts-link'));
    const r = await review(root);
    expect(r.unsupported.entries).toEqual([{ path: 'hosts-link', kind: 'symlink' }]);
    const err = await refusal(
      desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: r.reviewToken }),
    );
    expect(err.code).toBe('UNSUPPORTED_ENTRY');
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(existsSync(join(root, PROJECT_CONFIG_FILE))).toBe(false);
  });

  it('refuses a settings file it cannot trust and leaves it as it is', async () => {
    const root = designFolder();
    write(root, PROJECT_CONFIG_FILE, '{"schemaVersion": 9}');
    const r = await review(root);
    expect(r.config).toMatchObject({ status: 'invalid', reason: 'newer-schema' });
    const err = await refusal(
      desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: r.reviewToken }),
    );
    expect(err).toMatchObject({ code: 'CONFIG_INVALID', details: { reason: 'newer-schema' } });
    expect(readFileSync(join(root, PROJECT_CONFIG_FILE), 'utf8')).toBe('{"schemaVersion": 9}');
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('refuses with SCOPE_CHANGED when files come or go after the review', async () => {
    const root = designFolder();
    const r = await review(root);
    write(root, 'late.html', '<p>late</p>\n');
    const err = await refusal(
      desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: r.reviewToken }),
    );
    expect(err.code).toBe('SCOPE_CHANGED');
    expect(existsSync(join(root, '.git'))).toBe(false);
    // Reviewing again shows the new file, and connecting then works.
    const again = await review(root);
    expect(again.included.files).toBe(4);
    await desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: again.reviewToken });
  });

  it('only accepts entry pages that are saved', async () => {
    const root = designFolder();
    const r = await review(root);
    const err = await refusal(
      desktop.call('project.bind', { root, name: 'x', entryFiles: ['.env'], reviewToken: r.reviewToken }),
    );
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', details: { reason: 'entry-not-included' } });
  });

  it('keeps the project of an existing settings file, refuses a copy unless it becomes a new project, and relinks a moved folder', async () => {
    const original = designFolder();
    const projectId = await connectAndSave(original, 'Original');
    // The folder is copied (with its history): the same projectId twice.
    const copy = tempDir('dt-copy-');
    plainGit(copy, ['clone', '--quiet', original, '.']);
    const r = await review(copy);
    expect(r.config).toMatchObject({ status: 'valid', projectId });
    expect(r.binding).toMatchObject({ status: 'bound-elsewhere', available: true, project: { projectId } });
    const err = await refusal(
      desktop.call('project.bind', { root: copy, name: 'Copy', entryFiles: [], reviewToken: r.reviewToken }),
    );
    expect(err).toMatchObject({ code: 'PROJECT_ALREADY_BOUND', details: { projectId, root: original } });
    const asNew = await desktop.call('project.bind', {
      root: copy,
      name: 'Copy',
      entryFiles: [],
      reviewToken: r.reviewToken,
      asNewProject: true,
    });
    expect(asNew.project.projectId).not.toBe(projectId);
    expect(readConfig(copy).projectId).toBe(asNew.project.projectId);
    // The new id is a change of the settings file: the next save records it.
    expect((await desktop.call('project.status', { projectId: asNew.project.projectId })).changes).toMatchObject({
      total: 1,
      modified: 1,
    });

    // The original moves: its binding follows the folder, history included.
    const moved = `${original}-moved`;
    renameSync(original, moved);
    expect((await desktop.call('project.status', { projectId })).folder).toBe('missing');
    const m = await review(moved);
    expect(m.binding).toMatchObject({ status: 'bound-elsewhere', available: false });
    const relinked = await desktop.call('project.bind', {
      root: moved,
      name: 'Original',
      entryFiles: [],
      reviewToken: m.reviewToken,
    });
    expect(relinked).toMatchObject({ relinked: true, configWritten: false, project: { projectId, root: moved } });
    expect((await desktop.call('project.status', { projectId })).folder).toBe('available');
    rmSync(moved, { recursive: true, force: true });
  });

  it('opens an already connected folder instead of connecting it twice', async () => {
    const root = designFolder();
    const { project } = await connect(root);
    const r = await review(root);
    expect(r.binding).toMatchObject({ status: 'bound-here', project: { projectId: project.projectId } });
    const again = await desktop.call('project.bind', { root, name: 'x', entryFiles: [], reviewToken: r.reviewToken });
    expect(again).toMatchObject({ initialized: false, configWritten: false, project });
  });
});

describe('status, saving and history', () => {
  it('reports unsaved changes, saves them, and adds no version when nothing changed', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    let status = await desktop.call('project.status', { projectId });
    expect(status).toMatchObject({ folder: 'available', branch: 'main', changes: { total: 0 }, activeOperation: null });
    expect(status.tip).toMatchObject({ source: 'draft-tide', seq: 1, snapshot: { kind: 'baseline' } });

    write(root, 'index.html', '<h1>v2</h1>\n');
    write(root, 'about.html', '<h1>About</h1>\n');
    rmSync(join(root, 'css/site.css'));
    renameSync(join(root, 'img/hero.png'), join(root, 'img/cover.png'));
    status = await desktop.call('project.status', { projectId });
    expect(status.changes?.entries.map((c) => [c.change, c.path, c.previousPath])).toEqual([
      ['added', 'about.html', null],
      ['deleted', 'css/site.css', null],
      ['renamed', 'img/cover.png', 'img/hero.png'],
      ['modified', 'index.html', null],
    ]);
    // Status reads; it never writes the folder or its .git.
    const before = digestTree(join(root, '.git'));
    await desktop.call('project.status', { projectId });
    expect(digestTree(join(root, '.git'))).toEqual(before);

    const saved = await desktop.call('snapshot.create', { projectId, name: 'Second' });
    expect(saved).toMatchObject({ kind: 'manual', name: 'Second', newObjects: 2 });
    expect((await desktop.call('project.status', { projectId })).changes?.total).toBe(0);
    const err = await refusal(desktop.call('snapshot.create', { projectId, name: 'Again' }));
    expect(err.code).toBe('NO_CHANGES');
    expect(commits(root)).toBe(2);
  });

  it('shows other tools’ commits as external changes, and their copies as copies', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    write(root, 'index.html', '<h1>v2</h1>\n');
    const v2 = await desktop.call('snapshot.create', { projectId, name: 'Version two' });
    write(root, 'NOTES.md', '# notes\n');
    plainGit(root, ['add', 'NOTES.md']);
    plainGit(root, ['commit', '--quiet', '-m', 'Engineer notes']);
    // Another tool copies the Draft Tide commit (its message comes along).
    plainGit(root, ['cherry-pick', '--quiet', '--allow-empty', '--keep-redundant-commits', v2.commit]);

    const status = await desktop.call('project.status', { projectId });
    expect(status.tip).toMatchObject({ source: 'copy', copyOf: v2.commit, snapshot: null });
    const history = await desktop.call('history.list', { projectId });
    expect(history).toMatchObject({ total: 4, versions: 2, nextSkip: null });
    expect(history.entries.map((e) => [e.source, e.seq, e.title])).toEqual([
      ['copy', null, 'Version two'],
      ['external', null, 'Engineer notes'],
      ['draft-tide', 2, 'Version two'],
      ['draft-tide', 1, 'Baseline'],
    ]);
    expect(history.entries[1]).toMatchObject({ authorName: 'Fixture', snapshot: null });
    // The snapshot id names the version itself, never its copy.
    const diff = await desktop.call('snapshot.diff', { projectId, from: v2.snapshotId, to: status.tip?.commit ?? '' });
    expect(diff.from.commit).toBe(v2.commit);
    expect(diff.changes.map((c) => [c.change, c.path])).toEqual([['added', 'NOTES.md']]);
    // Saving continues on top of the other commits.
    write(root, 'index.html', '<h1>v3</h1>\n');
    const v3 = await desktop.call('snapshot.create', { projectId });
    expect(v3.parent).toBe(status.tip?.commit);
  });

  it('pages through history and refuses refs that are not on the line', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    for (let i = 0; i < 4; i++) {
      write(root, 'index.html', `<h1>v${i + 2}</h1>\n`);
      await desktop.call('snapshot.create', { projectId, name: `v${i + 2}` });
    }
    const first = await desktop.call('history.list', { projectId, limit: 2 });
    expect(first.entries.map((e) => e.seq)).toEqual([5, 4]);
    expect(first.nextSkip).toBe(2);
    const last = await desktop.call('history.list', { projectId, skip: 4, limit: 2 });
    expect(last.entries.map((e) => e.seq)).toEqual([1]);
    expect(last.nextSkip).toBeNull();
    plainGit(root, ['branch', 'side']);
    plainGit(root, ['checkout', '--quiet', 'side']);
    write(root, 'side.txt', 'x\n');
    plainGit(root, ['add', 'side.txt']);
    plainGit(root, ['commit', '--quiet', '-m', 'side']);
    const sideCommit = plainGit(root, ['rev-parse', 'HEAD']).trim();
    plainGit(root, ['checkout', '--quiet', 'main']);
    const head = first.entries[0]?.commit ?? '';
    for (const ref of [sideCommit, '0'.repeat(40), '00000000-0000-4000-8000-000000000000']) {
      expect((await refusal(desktop.call('snapshot.diff', { projectId, from: ref, to: head }))).code).toBe(
        'SNAPSHOT_NOT_FOUND',
      );
    }
    for (const ref of ['HEAD', 'main', head.slice(0, 7)]) {
      expect((await refusal(desktop.call('snapshot.diff', { projectId, from: ref, to: head }))).code).toBe(
        'INVALID_ARGUMENT',
      );
    }
  });

  it('compares a text file line by line and summarizes the rest', async () => {
    const root = designFolder();
    write(root, 'big.js', `${'// filler\n'.repeat(300_000)}`);
    write(root, 'crlf.txt', 'a\r\nb\r\n');
    const projectId = await connectAndSave(root);
    const v1 = (await desktop.call('history.list', { projectId })).entries[0]?.snapshot?.snapshotId ?? '';
    write(root, 'index.html', '<!doctype html>\n<link rel=stylesheet href=css/site.css>\n<h1>Plans</h1>\n');
    write(root, 'img/hero.png', randomBytes(4096));
    write(root, 'big.js', `${'// filler\n'.repeat(300_001)}`);
    write(root, 'crlf.txt', 'a\nb\n');
    const v2 = (await desktop.call('snapshot.create', { projectId })).snapshotId;

    const diff = await desktop.call('snapshot.diff', { projectId, from: v1, to: v2 });
    expect(diff.summary).toMatchObject({ modified: 4, total: 4 });
    const html = await desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: 'index.html' });
    expect(html).toMatchObject({
      kind: 'text',
      added: 1,
      removed: 1,
      hunks: [
        {
          lines: [
            ' <!doctype html>',
            ' <link rel=stylesheet href=css/site.css>',
            '-<h1>Pricing</h1>',
            '+<h1>Plans</h1>',
          ],
        },
      ],
    });
    expect(await desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: 'crlf.txt' })).toMatchObject({
      kind: 'text',
      lineEndings: { before: 'crlf', after: 'lf' },
    });
    expect(
      await desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: 'img/hero.png' }),
    ).toMatchObject({
      kind: 'summary',
      reason: 'binary',
    });
    expect(await desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: 'big.js' })).toMatchObject({
      kind: 'summary',
      reason: 'too-large',
    });
    expect(
      (await refusal(desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: 'nope.txt' }))).details,
    ).toMatchObject({ reason: 'path-not-found' });
    expect(
      (await refusal(desktop.call('snapshot.diffFile', { projectId, from: v1, to: v2, path: '../etc/passwd' }))).code,
    ).toBe('INVALID_ARGUMENT');
  });

  it('says what is wrong with the folder instead of saving into the wrong place', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    const settings = readFileSync(join(root, PROJECT_CONFIG_FILE));

    rmSync(join(root, PROJECT_CONFIG_FILE));
    expect((await desktop.call('project.status', { projectId })).folder).toBe('config-missing');
    expect((await refusal(desktop.call('snapshot.create', { projectId }))).details).toMatchObject({
      reason: 'missing',
    });

    write(root, PROJECT_CONFIG_FILE, '{nope');
    expect(await desktop.call('project.status', { projectId })).toMatchObject({
      folder: 'config-invalid',
      configProblem: { reason: 'not-json' },
    });

    const other = {
      ...(JSON.parse(settings.toString('utf8')) as object),
      projectId: '00000000-0000-4000-8000-000000000000',
    };
    write(root, PROJECT_CONFIG_FILE, JSON.stringify(other));
    expect((await desktop.call('project.status', { projectId })).folder).toBe('project-mismatch');
    expect((await refusal(desktop.call('snapshot.create', { projectId }))).details).toMatchObject({
      reason: 'project-mismatch',
    });

    writeFileSync(join(root, PROJECT_CONFIG_FILE), settings);
    renameSync(join(root, '.git'), join(root, '..', `${projectId}.git-aside`));
    expect((await desktop.call('project.status', { projectId })).folder).toBe('repo-missing');
    expect((await refusal(desktop.call('history.list', { projectId }))).details).toMatchObject({
      reason: 'repo-missing',
    });
    renameSync(join(root, '..', `${projectId}.git-aside`), join(root, '.git'));
    expect((await desktop.call('project.status', { projectId })).folder).toBe('available');
  });

  it('reports progress and the outcome of a save to the app', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    write(root, 'index.html', '<h1>progress</h1>\n');
    events.length = 0;
    const saved = await desktop.call('snapshot.create', { projectId });
    expect(saved.kind).toBe('manual');
    await expect.poll(() => events.some((e) => e.name === 'project.changed' && e.projectId === projectId)).toBe(true);
    const progress = events.filter((e) => e.name === 'operation.progress');
    expect(new Set(progress.map((e) => e.name === 'operation.progress' && e.progress.stage))).toEqual(
      new Set(['scan', 'hash', 'stage', 'verify', 'write', 'publish']),
    );
    expect(events.find((e) => e.name === 'operation.settled')).toMatchObject({
      outcome: 'completed',
      code: null,
      origin: 'gui',
    });
    events.length = 0;
    await refusal(desktop.call('snapshot.create', { projectId }));
    await expect
      .poll(() => events.find((e) => e.name === 'operation.settled'))
      .toMatchObject({ outcome: 'no-changes', code: 'NO_CHANGES' });
  });
});

describe('the tool channel', () => {
  it('cannot review or connect folders, and needs agent access for the rest', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    await desktop.call('agentAccess.set', { enabled: false });
    const off = cliJson('--project', projectId, 'status');
    expect(off.envelope).toMatchObject({ ok: false, error: { code: 'AGENT_ACCESS_DISABLED' } });
    await desktop.call('agentAccess.set', { enabled: true });
    const tool = await connectTo(dataDir, 'cli', 5_000);
    for (const op of ['project.review', 'project.bind']) {
      const err = await refusal(tool.callRaw(op, { root, name: 'x', entryFiles: [], reviewToken: 'f'.repeat(64) }));
      expect(err.code).toBe('UNKNOWN_OPERATION');
    }
    tool.close();
    await desktop.call('agentAccess.set', { enabled: false });
  });

  it('saves, reads history and compares through the CLI with the same results', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root, 'CLI project');
    await desktop.call('agentAccess.set', { enabled: true });
    try {
      write(root, 'index.html', '<h1>from the agent</h1>\n');
      const human = cli('--project', projectId, 'status');
      expect(human.status).toBe(EXIT_CODES.ok);
      expect(human.stdout).toMatch(/Unsaved changes: 1 \(0 added, 1 modified/);
      expect(human.stdout).toMatch(/ {2}M {2}index\.html/);

      const saved = cliJson('--project', projectId, 'snapshot', '--message', 'Agent pass');
      expect(saved.status).toBe(EXIT_CODES.ok);
      expect(saved.envelope).toMatchObject({
        ok: true,
        data: { kind: 'agent-requested', origin: 'cli', name: 'Agent pass' },
      });
      // Nothing changed: exit code 3, NO_CHANGES, not a failure.
      const again = cliJson('--project', projectId, 'snapshot');
      expect(again.status).toBe(EXIT_CODES.noop);
      expect(again.envelope).toMatchObject({ ok: false, error: { code: 'NO_CHANGES' } });

      const history = cliJson('--project', projectId, 'history');
      const entries = (history.envelope['data'] as { entries: { snapshot: { snapshotId: string } | null }[] }).entries;
      const [newer, older] = entries.map((e) => e.snapshot?.snapshotId ?? '');
      expect(cli('--project', projectId, 'history').stdout).toMatch(/V2 "Agent pass" \(agent-requested, cli\)/);
      const diff = cli('--project', projectId, 'diff', older ?? '', newer ?? '', '--file', 'index.html');
      expect(diff.stdout).toContain('-<h1>Pricing</h1>');
      expect(diff.stdout).toContain('+<h1>from the agent</h1>');
      // The app sees the agent's version, marked as such.
      const page = await desktop.call('history.list', { projectId });
      expect(page.entries[0]?.snapshot).toMatchObject({ kind: 'agent-requested', origin: 'cli' });
    } finally {
      await desktop.call('agentAccess.set', { enabled: false });
    }
  });

  it('answers a missing --project and unknown projects with stable errors', async () => {
    await desktop.call('agentAccess.set', { enabled: true });
    try {
      const missing = cliJson('status');
      expect(missing.status).toBe(EXIT_CODES.usage);
      expect(missing.envelope).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
      const unknown = cliJson('--project', '00000000-0000-4000-8000-000000000000', 'status');
      expect(unknown.status).toBe(EXIT_CODES.failed);
      expect(unknown.envelope).toMatchObject({ error: { code: 'PROJECT_NOT_BOUND' } });
      const badLimit = cliJson('--project', '00000000-0000-4000-8000-000000000000', 'history', '--limit', 'ten');
      expect(badLimit.status).toBe(EXIT_CODES.usage);
    } finally {
      await desktop.call('agentAccess.set', { enabled: false });
    }
  });

  it.skipIf(onWindows)('prints other tools’ titles without terminal escapes', async () => {
    const root = designFolder();
    const projectId = await connectAndSave(root);
    write(root, 'x.txt', 'x\n');
    plainGit(root, ['add', 'x.txt']);
    plainGit(root, ['commit', '--quiet', '-m', 'evil \u001b]0;pwned\u0007 title']);
    await desktop.call('agentAccess.set', { enabled: true });
    try {
      const out = cli('--project', projectId, 'history').stdout;
      expect(out).not.toContain('\u001b');
      expect(out).toContain('evil �]0;pwned� title');
    } finally {
      await desktop.call('agentAccess.set', { enabled: false });
    }
  });
});

describe('the folder on disk', () => {
  it.skipIf(onWindows)('writes .drafttide.json readable like any design file, with nothing left behind', async () => {
    const root = designFolder();
    mkdirSync(join(root, 'sub'));
    await connect(root);
    const { mode } = statSync(join(root, PROJECT_CONFIG_FILE));
    expect(mode & 0o777).toBe(0o644);
    expect(spawnSync('ls', ['-A', root], { encoding: 'utf8' }).stdout).not.toContain('dt-tmp');
  });
});
