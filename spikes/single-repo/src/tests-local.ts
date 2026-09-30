import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.ts';
import type { GitRuntime } from './git.ts';
import { probeRepo } from './probe.ts';
import { DesignRepo } from './repo.ts';
import { addNoise, assert, del, designFixture, eq, link, put, randomBytes, read, rejectsWith, walkFiles, type Ext, type Suite, type Work } from './harness.ts';

export interface Ctx {
  w: Work;
  ext: Ext;
  rt: GitRuntime;
  s: Suite;
}

const HERE = dirname(fileURLToPath(import.meta.url));

// Everything the user's own repo owns that Draft Tide must leave alone.
function userState(ext: Ext, root: string) {
  const refs = ext.git(root, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n').filter(Boolean);
  return {
    config: readFileSync(join(root, '.git', 'config'), 'utf8'),
    head: readFileSync(join(root, '.git', 'HEAD'), 'utf8'),
    hooks: existsSync(join(root, '.git', 'hooks')) ? readdirSync(join(root, '.git', 'hooks')).sort() : [],
    otherRefs: refs.filter((r) => !r.startsWith('refs/heads/main ')),
  };
}

const EXPECTED_TREE = ['.drafttide.json', '.gitignore', 'app.js', 'assets/hero.jpg', 'assets/logo.png', 'index.html', 'notes.txt', 'scripts/run.sh', 'styles.css'];

async function adopt(c: Ctx, root: string, name = 'Aurora'): Promise<DesignRepo> {
  return DesignRepo.adopt(c.rt, c.w.dataDir, root, { name, entryFiles: ['index.html'] });
}

function runChild(c: Ctx, cmd: string, root: string, extra: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(HERE, 'cli.ts'), cmd, '--root', root, '--data', c.w.dataDir, '--home', c.w.gitHome, ...extra], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
}

export async function runLocalTests(c: Ctx): Promise<void> {
  const { w, ext, rt, s } = c;

  // ------------------------------------------------------------------ A
  s.begin('A. Adopt an existing repo and save');

  let aRoot = '';
  await s.check('A1 adopt a repo with other people’s history; baseline save', async () => {
    aRoot = designFixture(w, ext, 'aurora');
    addNoise(aRoot);
    ext.git(aRoot, ['branch', 'other']);
    ext.git(aRoot, ['tag', 'v0']);
    put(aRoot, 'notes.txt', 'stash me\n');
    ext.git(aRoot, ['stash', 'push', '-q', '-m', 's1']);
    const before = userState(ext, aRoot);
    const engineerTip = ext.head(aRoot);

    const probe = await probeRepo(rt, aRoot);
    eq(probe.blockers, [], 'probe blockers');
    const repo = await adopt(c, aRoot);
    const r = await repo.save({ name: 'Baseline' });
    eq(r.parent, engineerTip, 'parent is the engineer’s last commit');
    eq(ext.head(aRoot), r.commit, 'branch tip');
    eq(ext.lsTree(aRoot), EXPECTED_TREE, 'snapshot tree');
    assert(ext.git(aRoot, ['ls-tree', 'HEAD', 'scripts/run.sh']).startsWith('100755'), 'executable bit preserved');
    for (const f of EXPECTED_TREE) {
      const blob = ext.git(aRoot, ['rev-parse', `HEAD:${f}`]).trim();
      const raw = ext.git(aRoot, ['hash-object', '--no-filters', join(aRoot, f)]).trim();
      eq(blob, raw, `blob bytes of ${f}`);
    }
    const status = ext.status(aRoot).split('\n').sort();
    eq(status, ['?? .DS_Store', '?? .env'], 'git status after save (only the default-excluded new files)');
    assert(ext.try(aRoot, ['fsck', '--strict', '--no-dangling']).ok, 'git fsck');
    const after = userState(ext, aRoot);
    eq(after.config, before.config, '.git/config untouched');
    eq(after.head, before.head, 'HEAD file untouched');
    eq(after.hooks, before.hooks, 'hooks untouched');
    eq(after.otherRefs, before.otherRefs, 'other branches, tags and stash untouched');
    const msgs = ext.git(aRoot, ['log', '--format=%B']);
    assert(!msgs.includes(w.dir) && !msgs.includes(aRoot), 'no absolute path in commit messages');
    const h = await repo.history();
    assert(h[0]?.meta?.kind === 'baseline', `newest entry is the Draft Tide baseline (got ${h[0]?.meta?.kind})`);
    assert(h[1] !== undefined && h[1].meta === null && h[1].author === 'Engineer', 'engineer commits appear as external history');
    return `${r.stats.files} files, ${Math.round(r.stats.ms)} ms`;
  });

  await s.check('A2 staged + unstaged + deleted + untracked mixed state saves as-is and leaves git status clean', async () => {
    const root = designFixture(w, ext, 'mixed');
    const repo = await adopt(c, root);
    await repo.save({ name: 'Baseline' });
    put(root, 'index.html', '<h1>staged edit</h1>\n');
    ext.git(root, ['add', 'index.html']);
    put(root, 'styles.css', 'v2\n');
    ext.git(root, ['add', 'styles.css']);
    const stagedBlob = ext.git(root, ['ls-files', '-s', 'styles.css']).split(/\s+/)[1] as string;
    put(root, 'styles.css', 'v3-unstaged-on-top\n');
    del(root, 'app.js');
    ext.git(root, ['rm', '-q', 'notes.txt']);
    put(root, 'b.html', 'untracked\n');
    put(root, 'c.html', 'staged new\n');
    ext.git(root, ['add', 'c.html']);
    const r = await repo.save({ name: 'Mixed' });
    const tree = ext.lsTree(root);
    assert(tree.includes('b.html') && tree.includes('c.html'), 'new files captured');
    assert(!tree.includes('app.js') && !tree.includes('notes.txt'), 'deleted files left out');
    eq(ext.git(root, ['show', 'HEAD:styles.css']), 'v3-unstaged-on-top\n', 'working-tree bytes win over the staged version');
    eq(ext.status(root), '', 'git status after save');
    eq(ext.try(root, ['diff', '--cached', '--quiet']).ok, true, 'nothing staged after save');
    const kept = ext.try(root, ['cat-file', '-e', stagedBlob]).ok;
    s.observe('A2 partial-staging intent', `the staged-only version of styles.css is no longer in the index (object still in the object store: ${kept}); it is unreachable until Git gc prunes it`);
  });

  await s.check('A3 unborn branch: first save creates the root commit', async () => {
    const root = w.fresh('unborn');
    ext.git(root, ['init', '-q', '-b', 'main']);
    put(root, 'index.html', '<h1>hi</h1>\n');
    put(root, 'app.js', '1\n');
    const repo = await adopt(c, root, 'Unborn');
    const r = await repo.save({});
    eq(r.parent, null, 'no parent');
    eq(ext.git(root, ['rev-list', '--count', 'HEAD']).trim(), '1', 'one commit');
    eq(ext.status(root), '', 'git status');
  });

  await s.check('A4 plain folder (no .git): git init, baseline, clean status, no hook samples', async () => {
    const root = w.fresh('plain');
    put(root, 'index.html', '<h1>hi</h1>\n');
    put(root, 'assets/a.png', randomBytes(500, 2));
    const repo = await adopt(c, root, 'Plain');
    assert(existsSync(join(root, '.git')), '.git created');
    assert(!existsSync(join(root, '.git', 'hooks')) || readdirSync(join(root, '.git', 'hooks')).length === 0, 'no hook samples copied');
    const r = await repo.save({});
    eq(ext.status(root), '', 'git status');
    eq(ext.lsTree(root), ['.drafttide.json', 'assets/a.png', 'index.html'], 'tree');
  });

  await s.check('A5 NO_CHANGES on repeat; a config-only edit is a real change', async () => {
    const root = designFixture(w, ext, 'nochanges');
    const repo = await adopt(c, root);
    await repo.save({});
    await rejectsWith(() => repo.save({}), 'NO_CHANGES', 'second save');
    const cfg = JSON.parse(read(root, CONFIG_FILE)) as Record<string, unknown>;
    cfg['name'] = 'Renamed';
    put(root, CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
    const r = await repo.save({});
    assert(r.commit, 'config edit saved');
  });

  await s.check('A6 saves land on the checked-out branch; other branches stay put', async () => {
    const root = designFixture(w, ext, 'branch');
    const repo = await adopt(c, root);
    await repo.save({ name: 'Baseline on main' });
    const mainTip = ext.head(root);
    ext.git(root, ['checkout', '-q', '-b', 'direction-b']);
    put(root, 'index.html', '<h1>direction b</h1>\n');
    const r = await repo.save({ name: 'B1' });
    eq(r.ref, 'refs/heads/direction-b', 'ref');
    eq(ext.git(root, ['rev-parse', 'main']).trim(), mainTip, 'main untouched');
    eq(ext.status(root), '', 'git status');
  });

  await s.check('A7 a tracked path under a directory swapped for a symlink is refused and never read', async () => {
    const root = designFixture(w, ext, 'symlink');
    put(root, 'a/secret.txt', 'original\n');
    ext.commitAll(root, 'add a/');
    const outside = w.fresh('outside');
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET-OUTSIDE-THE-PROJECT\n');
    const repo = await adopt(c, root);
    rmSync(join(root, 'a'), { recursive: true });
    link(root, 'a', outside);
    const tipBefore = ext.head(root);
    await rejectsWith(() => repo.save({}), 'UNSUPPORTED_ENTRY', 'symlinked parent');
    eq(ext.head(root), tipBefore, 'no commit made');
    const leaked = spawnSync('/usr/bin/git', ['cat-file', '-e', hashOf(ext, w, 'TOPSECRET-OUTSIDE-THE-PROJECT\n')], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: w.extHome } });
    assert(leaked.status !== 0, 'outside content never entered the object store');
  });

  await s.check('A8 tracked files are always in scope; default excludes only gate new files', async () => {
    const root = designFixture(w, ext, 'scoperule');
    put(root, '.env', 'OLD=1\n');
    put(root, 'keep/x.log', 'tracked log\n');
    ext.git(root, ['add', '-f', '.env', 'keep/x.log']);
    ext.git(root, ['commit', '-q', '-m', 'tracked .env and a tracked log']);
    const repo = await adopt(c, root);
    put(root, '.env', 'NEW=2\n');
    put(root, '.env.local', 'untracked secret\n');
    put(root, 'id_rsa_backup', 'key\n');
    put(root, 'keep/y.log', 'new log\n');
    await repo.save({});
    const tree = ext.lsTree(root);
    assert(tree.includes('.env') && tree.includes('keep/x.log'), 'tracked .env and tracked log stay');
    assert(!tree.includes('.env.local') && !tree.includes('id_rsa_backup') && !tree.includes('keep/y.log'), 'new secrets and logs are excluded');
    eq(ext.git(root, ['show', 'HEAD:.env']), 'NEW=2\n', 'tracked file updated');
  });

  await s.check('A9 excludes from .drafttide.json are honored (hand-edited)', async () => {
    const root = designFixture(w, ext, 'cfgexclude');
    const repo = await adopt(c, root);
    const cfg = JSON.parse(read(root, CONFIG_FILE)) as { excludeDirNames: string[] };
    cfg.excludeDirNames.push('drafts');
    put(root, CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
    put(root, 'drafts/wip.png', randomBytes(100, 5));
    put(root, 'final/ok.png', randomBytes(100, 6));
    await repo.save({});
    const tree = ext.lsTree(root);
    assert(!tree.includes('drafts/wip.png') && tree.includes('final/ok.png'), 'drafts excluded, final saved');
  });

  await s.check('A10 CJK, spaces, emoji and NFC/NFD file names save, read back byte-exact and keep git status clean', async () => {
    const root = designFixture(w, ext, 'unicode');
    const repo = await adopt(c, root);
    const nfc = 'caf\u00e9-nfc.html';
    const nfd = 'cafe\u0301-nfd.html';
    const names = ['設計稿/首頁 v2.html', '圖片/🌊 wave.png', nfc, nfd];
    for (const n of names) put(root, n, `content of ${n}\n`);
    await repo.save({});
    const listed = ext.git(root, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).map((n) => n.normalize('NFC'));
    for (const n of names) assert(listed.includes(n.normalize('NFC')), `${n} is in the tree`);
    eq(ext.status(root), '', 'git status');
    put(root, '設計稿/首頁 v2.html', 'edited\n');
    const r2 = await repo.save({});
    eq(ext.git(root, ['show', `${r2.commit}:設計稿/首頁 v2.html`]), 'edited\n', 'CJK path content');
    const dirty = ext.status(root);
    eq(dirty, '', 'git status after the second save');
  });

  await s.check('A11 an execute-bit-only change is a real change and saves as mode 100755', async () => {
    const root = designFixture(w, ext, 'modeonly');
    const repo = await adopt(c, root);
    await repo.save({});
    put(root, 'notes.txt', 'first notes\n', 0o755);
    await repo.save({});
    assert(ext.git(root, ['ls-tree', 'HEAD', 'notes.txt']).startsWith('100755'), 'mode recorded');
    eq(ext.status(root), '', 'git status');
  });

  // ------------------------------------------------------------------ B
  s.begin('B. Index sync, concurrency and crash recovery');

  await s.check('B1 SIGKILL right after the ref moves: our lock is left behind, recover() finishes the index', async () => {
    const root = designFixture(w, ext, 'crash1');
    const repo = await adopt(c, root);
    await repo.save({});
    put(root, 'index.html', '<h1>crash test</h1>\n');
    const r = runChild(c, 'save', root, [], { SPIKE_CRASH_AT: 'after-update-ref' });
    eq(r.signal, 'SIGKILL', 'child was killed');
    const tipAfterCrash = ext.head(root);
    assert(read(root, '.git/index.lock').startsWith('draft-tide '), 'our identifiable lock is left behind');
    const noise = ext.status(root).split('\n').filter(Boolean);
    s.observe('B1 git status between crash and recovery', `${noise.length} line(s): ${noise.slice(0, 3).join(' | ')}`);
    assert(noise.length > 0, 'the stale index is observable (this is the window recovery closes)');
    const rec = JSON.parse(runChild(c, 'recover', root).out) as { ok: boolean; data: { completed: string[] } };
    eq(rec.data.completed.length, 1, 'one operation completed by recovery');
    eq(ext.head(root), tipAfterCrash, 'recovery does not move the branch');
    assert(!existsSync(join(root, '.git', 'index.lock')), 'lock released');
    eq(ext.status(root), '', 'git status after recovery');
    eq(await repo.indexTree(), ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim(), 'index matches HEAD tree');
    eq(readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.dt-')), [], 'temporary index files cleaned up');
  });

  await s.check('B2 SIGKILL before the ref moves: nothing is visible; recover() abandons; retry works', async () => {
    const root = designFixture(w, ext, 'crash2');
    const repo = await adopt(c, root);
    await repo.save({});
    const tip = ext.head(root);
    put(root, 'index.html', '<h1>crash before ref</h1>\n');
    const before = ext.status(root);
    const r = runChild(c, 'save', root, [], { SPIKE_CRASH_AT: 'before-update-ref' });
    eq(r.signal, 'SIGKILL', 'child was killed');
    eq(ext.head(root), tip, 'branch did not move');
    eq(ext.status(root), before, 'git status unchanged');
    const rec = JSON.parse(runChild(c, 'recover', root).out) as { data: { abandoned: string[] } };
    eq(rec.data.abandoned.length, 1, 'operation abandoned');
    const ok = await repo.save({});
    assert(ok.commit !== tip, 'retry saved');
    assert(ext.try(root, ['fsck', '--strict', '--no-dangling']).ok, 'fsck');
  });

  await s.check('B3 another Git holds index.lock: save refuses with LOCKED before publishing anything; works once it is free', async () => {
    const root = designFixture(w, ext, 'lock');
    const repo = await adopt(c, root);
    await repo.save({});
    const tip = ext.head(root);
    put(root, 'index.html', '<h1>locked</h1>\n');
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const e = await rejectsWith(() => repo.save({ indexLockWaitMs: 200 }), 'LOCKED', 'lock held');
    void e;
    eq(ext.head(root), tip, 'no commit was made');
    eq(readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.dt-')), [], 'no temporary index left');
    eq(ext.status(root), 'M index.html'.padStart(12), 'working change untouched');
    rmSync(join(root, '.git', 'index.lock'));
    await repo.save({});
    eq(ext.status(root), '', 'git status');
  });

  await s.check('B4 an engineer commits while we save: HISTORY_CHANGED, nothing overwritten, retry chains on top', async () => {
    const root = designFixture(w, ext, 'race');
    const repo = await adopt(c, root);
    await repo.save({});
    put(root, 'styles.css', 'ours\n');
    let external = '';
    await rejectsWith(
      () =>
        repo.save({
          beforeUpdateRef: () => {
            put(root, 'notes.txt', 'engineer edit\n');
            ext.git(root, ['commit', '-q', '-m', 'engineer commits notes only', 'notes.txt']);
            external = ext.head(root);
          },
        }),
      'HISTORY_CHANGED',
      'CAS',
    );
    eq(ext.head(root), external, 'engineer’s commit is the tip');
    eq(ext.status(root), 'M styles.css'.padStart(12), 'our edit is still an ordinary working change');
    const r = await repo.save({});
    eq(r.parent, external, 'retry chains on the engineer’s commit');
    eq(ext.status(root), '', 'git status');
    eq(ext.git(root, ['show', 'HEAD:styles.css']), 'ours\n', 'our change saved');
  });

  await s.check('B7 a plain `git commit` in the crash window fails loudly (the old protocol let it silently commit the old tree)', async () => {
    const root = designFixture(w, ext, 'crash-commit');
    const repo = await adopt(c, root);
    await repo.save({});
    put(root, 'index.html', '<h1>designer save</h1>\n');
    const r = runChild(c, 'save', root, [], { SPIKE_CRASH_AT: 'after-update-ref' });
    eq(r.signal, 'SIGKILL', 'child was killed');
    const snapshot = ext.head(root);
    const snapshotTree = ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const plain = ext.try(root, ['commit', '--allow-empty', '-q', '-m', 'someone: plain git commit']);
    assert(!plain.ok && /index\.lock/.test(plain.err), `plain git commit must be refused by the lock (got: ${plain.err.trim().split('\n')[0]})`);
    eq(ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim(), snapshotTree, 'tip tree unchanged');
    s.observe('B7 plain `git commit` in the window', `refused loudly: ${plain.err.trim().split('\n')[0]}`);

    // Residual risk: the user follows Git's advice and deletes the "stale" lock.
    rmSync(join(root, '.git', 'index.lock'));
    const after = ext.try(root, ['commit', '--allow-empty', '-q', '-m', 'someone: commit after removing the lock']);
    const reverted = after.ok && ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim() !== snapshotTree;
    s.observe('B7 residual: lock deleted by hand, then plain `git commit`', reverted ? 'silently commits the OLD tree (snapshot stays in history, working files intact)' : 'no revert');
    const rec = await repo.recover();
    eq(rec.superseded.length, 1, 'recovery sees that someone committed on top and leaves their index alone');
    assert(ext.try(root, ['merge-base', '--is-ancestor', snapshot, 'HEAD']).ok, 'the snapshot commit is still in history');
    eq(read(root, 'index.html'), '<h1>designer save</h1>\n', 'working file intact');
  });

  await s.check('B8 SIGKILL right after a restore moved the ref: lock left, recover() repairs the index, files stay restored', async () => {
    const root = designFixture(w, ext, 'crash-restore');
    const repo = await adopt(c, root);
    const base = await repo.save({ name: 'Baseline' });
    put(root, 'index.html', '<h1>v2</h1>\n');
    await repo.save({ name: 'v2' });
    const r = runChild(c, 'restore', root, ['--target', base.commit], { SPIKE_CRASH_AT: 'after-update-ref' });
    eq(r.signal, 'SIGKILL', 'child was killed');
    assert(existsSync(join(root, '.git', 'index.lock')), 'lock left behind');
    const rec = await repo.recover();
    eq(rec.completed.length, 1, 'recovery completed the restore publish');
    eq(ext.status(root), '', 'git status');
    eq(ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim(), ext.git(root, ['rev-parse', `${base.commit}^{tree}`]).trim(), 'tip tree is the restored tree');
  });

  await s.check('B5 merge in progress: REPO_BUSY, index and conflict markers untouched', async () => {
    const root = designFixture(w, ext, 'merge');
    const repo = await adopt(c, root);
    await repo.save({});
    ext.git(root, ['checkout', '-q', '-b', 'topic']);
    put(root, 'styles.css', 'topic\n');
    ext.git(root, ['commit', '-qam', 'topic']);
    ext.git(root, ['checkout', '-q', 'main']);
    put(root, 'styles.css', 'main\n');
    ext.git(root, ['commit', '-qam', 'main']);
    assert(!ext.try(root, ['merge', 'topic']).ok, 'merge conflicts as intended');
    const unmergedBefore = ext.git(root, ['ls-files', '-u']);
    const file = read(root, 'styles.css');
    await rejectsWith(() => repo.save({}), 'REPO_BUSY', 'during merge');
    eq(ext.git(root, ['ls-files', '-u']), unmergedBefore, 'unmerged entries untouched');
    eq(read(root, 'styles.css'), file, 'conflict markers untouched');
    ext.git(root, ['merge', '--abort']);
  });

  await s.check('B6 detached HEAD and in-progress rebase are refused', async () => {
    const root = designFixture(w, ext, 'detached');
    const repo = await adopt(c, root);
    await repo.save({});
    put(root, 'index.html', 'edit\n');
    mkdirSync(join(root, '.git', 'rebase-merge'));
    await rejectsWith(() => repo.save({}), 'REPO_BUSY', 'rebase-merge');
    rmSync(join(root, '.git', 'rebase-merge'), { recursive: true });
    ext.git(root, ['checkout', '-q', '--detach']);
    const e = await rejectsWith(() => repo.save({}), 'REPO_UNSUPPORTED', 'detached HEAD');
    assert(JSON.stringify(e.details).includes('detached-head'), 'reason is detached-head');
  });

  // ------------------------------------------------------------------ C
  s.begin('C. Repo forms and attributes that must be refused (or are harmless)');

  const probeReason = async (root: string): Promise<string[]> => (await probeRepo(rt, root)).blockers.map((b) => b.reason);

  await s.check('C1 shallow clone', async () => {
    const src = designFixture(w, ext, 'shallow-src');
    const dst = join(w.fresh('shallow-dst'), 'clone');
    ext.git(w.dir, ['clone', '-q', '--depth', '1', `file://${src}`, dst]);
    assert((await probeReason(dst)).includes('shallow-clone'), 'shallow-clone blocker');
  });

  await s.check('C2 linked worktree (.git is a file)', async () => {
    const root = designFixture(w, ext, 'wt-main');
    const wt = join(w.fresh('wt'), 'linked');
    ext.git(root, ['worktree', 'add', '-q', wt, '-b', 'wtbranch']);
    assert((await probeReason(wt)).includes('linked-worktree-or-submodule'), 'blocker');
  });

  await s.check('C3 submodule gitlink in the index', async () => {
    const root = designFixture(w, ext, 'submodule');
    ext.git(root, ['update-index', '--add', '--cacheinfo', `160000,${ext.head(root)},vendor/sub`]);
    const repo = await adopt(c, root);
    const e = await rejectsWith(() => repo.save({}), 'REPO_UNSUPPORTED', 'submodule');
    assert(JSON.stringify(e.details).includes('submodule'), 'reason is submodule');
  });

  await s.check('C4 sparse checkout, skip-worktree flag, partial clone, sha256, reftable', async () => {
    const a = designFixture(w, ext, 'sparse');
    ext.git(a, ['config', 'core.sparseCheckout', 'true']);
    assert((await probeReason(a)).includes('sparse-checkout'), 'sparse-checkout');
    const b = designFixture(w, ext, 'skipwt');
    ext.git(b, ['update-index', '--skip-worktree', 'notes.txt']);
    assert((await probeReason(b)).includes('index-flags'), 'skip-worktree');
    const p = designFixture(w, ext, 'partial');
    ext.git(p, ['config', 'extensions.partialClone', 'origin']);
    assert((await probeReason(p)).includes('partial-clone'), 'partial-clone');
    const sha = w.fresh('sha256');
    const r = ext.try(sha, ['init', '-q', '--object-format=sha256']);
    if (r.ok) assert((await probeReason(sha)).includes('sha256-object-format'), 'sha256');
    const rt2 = w.fresh('reftable');
    const r2 = ext.try(rt2, ['init', '-q', '--ref-format=reftable']);
    if (r2.ok) assert((await probeReason(rt2)).includes('reftable'), 'reftable');
    return `sha256 init ${r.ok ? 'tested' : 'unsupported by this git'}, reftable init ${r2.ok ? 'tested' : 'unsupported by this git'}`;
  });

  await s.check('C5 Git LFS attributes are refused (raw bytes would bypass LFS)', async () => {
    const root = designFixture(w, ext, 'lfs');
    put(root, '.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n');
    ext.commitAll(root, 'use lfs for png');
    const repo = await adopt(c, root);
    put(root, 'index.html', 'changed\n');
    const e = await rejectsWith(() => repo.save({}), 'REPO_UNSUPPORTED', 'lfs');
    assert(JSON.stringify(e.details).includes('git-lfs'), 'reason is git-lfs');
    const ok = designFixture(w, ext, 'lfs-unused');
    put(ok, '.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    ext.commitAll(ok, 'lfs rule for files this repo does not have');
    await (await adopt(c, ok)).save({});
  });

  await s.check('C6 nested in another repo, and an untracked nested repo', async () => {
    const outer = designFixture(w, ext, 'outer');
    const inner = join(outer, 'sub', 'design');
    mkdirSync(inner, { recursive: true });
    put(inner, 'index.html', 'x\n');
    await rejectsWith(() => adopt(c, inner), 'REPO_UNSUPPORTED', 'inside another repo');
    const root = designFixture(w, ext, 'nestedrepo');
    const repo = await adopt(c, root);
    mkdirSync(join(root, 'vendor', 'lib'), { recursive: true });
    ext.git(join(root, 'vendor', 'lib'), ['init', '-q']);
    put(root, 'vendor/lib/a.js', '1\n');
    const e = await rejectsWith(() => repo.save({}), 'REPO_UNSUPPORTED', 'nested repo');
    assert(JSON.stringify(e.details).includes('nested-repo'), 'reason is nested-repo');
  });

  await s.check('C7 attributes: text=auto with LF is fine; explicit text + CR is refused, and the control proves why', async () => {
    const okRoot = designFixture(w, ext, 'attr-ok');
    put(okRoot, '.gitattributes', '* text=auto\n');
    ext.commitAll(okRoot, 'text=auto');
    const repo = await adopt(c, okRoot);
    put(okRoot, 'index.html', 'lf only\n');
    await repo.save({});
    eq(ext.status(okRoot), '', 'text=auto + LF: git status clean');

    const auto = designFixture(w, ext, 'attr-auto-crlf');
    put(auto, '.gitattributes', '* text=auto\n');
    ext.commitAll(auto, 'text=auto');
    const autoRepo = await adopt(c, auto);
    put(auto, 'crlf.txt', 'a\r\nb\r\n');
    await autoRepo.save({});
    s.observe('C7 text=auto + a CRLF file', ext.status(auto) === '' ? 'git status clean (Git keeps CRLF already in the index)' : `git status: ${ext.status(auto)}`);

    const bad = designFixture(w, ext, 'attr-text');
    put(bad, '.gitattributes', '*.txt text\n');
    ext.commitAll(bad, 'text');
    const badRepo = await adopt(c, bad);
    put(bad, 'crlf.txt', 'a\r\nb\r\n');
    const e = await rejectsWith(() => badRepo.save({}), 'REPO_UNSUPPORTED', 'text + CR');
    assert(JSON.stringify(e.details).includes('line-ending-normalization'), 'reason is line-ending-normalization');
    await badRepo.save({ skipAttributeChecks: true });
    const dirty = ext.status(bad);
    assert(dirty !== '', 'control: without the refusal, git status would show the file as modified');
    s.observe('C7 control (check disabled)', `git status: ${dirty}`);
  });

  await s.check('C8 core.autocrlf=true in the repo config: CRLF and LF files both save and git status stays clean', async () => {
    const root = designFixture(w, ext, 'autocrlf');
    ext.git(root, ['config', '--local', 'core.autocrlf', 'true']);
    const repo = await adopt(c, root);
    put(root, 'crlf.txt', 'a\r\nb\r\n');
    put(root, 'lf.txt', 'a\nb\n');
    await repo.save({});
    eq(ext.git(root, ['show', 'HEAD:crlf.txt']), 'a\r\nb\r\n', 'CRLF bytes kept as they are');
    eq(ext.status(root), '', 'git status');
  });

  // ------------------------------------------------------------------ G
  s.begin('G. Restore appends history');

  await s.check('G1 restore: pre-restore + restore commits appended, tip moves forward, status clean', async () => {
    const root = designFixture(w, ext, 'restore');
    const repo = await adopt(c, root);
    const base = await repo.save({ name: 'Baseline' });
    put(root, 'index.html', '<h1>v2</h1>\n');
    await repo.save({ name: 'v2' });
    put(root, 'notes.txt', 'v3 notes\n');
    await repo.save({ name: 'v3' });
    put(root, 'styles.css', 'unsaved work\n');
    const plan = await repo.planRestore(base.commit);
    eq(plan.unsavedChanges, true, 'unsaved work detected');
    const tipBefore = ext.head(root);
    const r = await repo.applyRestore(plan, 'gui');
    assert(r.protection !== null, 'protection commit made');
    const kinds = (await repo.history()).slice(0, 5).map((h) => h.meta?.kind ?? 'external');
    eq(kinds.slice(0, 4), ['restore', 'pre-restore', 'manual', 'manual'], 'history appended');
    assert(ext.try(root, ['merge-base', '--is-ancestor', tipBefore, 'HEAD']).ok, 'old tip is an ancestor of the new tip (never rewound)');
    eq(ext.git(root, ['rev-parse', 'HEAD^{tree}']).trim(), ext.git(root, ['rev-parse', `${base.commit}^{tree}`]).trim(), 'restore tree equals target tree');
    eq(read(root, 'index.html'), ext.git(root, ['show', `${base.commit}:index.html`]), 'working file restored');
    eq(ext.status(root), '', 'git status');
    eq(ext.git(root, ['show', `${r.protection?.commit}:styles.css`]), 'unsaved work\n', 'unsaved work is in the protection commit');
  });

  await s.check('G2 restore refuses unsaved new files, and a plan goes stale when files change', async () => {
    const root = designFixture(w, ext, 'restore2');
    const repo = await adopt(c, root);
    const base = await repo.save({});
    put(root, 'index.html', 'v2\n');
    await repo.save({});
    put(root, 'new-unsaved.html', 'precious\n');
    const plan = await repo.planRestore(base.commit);
    await rejectsWith(() => repo.applyRestore(plan), 'UNTRACKED_FILES', 'unsaved new file');
    eq(read(root, 'new-unsaved.html'), 'precious\n', 'file untouched');
    del(root, 'new-unsaved.html');
    const plan2 = await repo.planRestore(base.commit);
    put(root, 'styles.css', 'changed after plan\n');
    await rejectsWith(() => repo.applyRestore(plan2), 'PLAN_STALE', 'plan');
  });

  // ------------------------------------------------------------------ I
  s.begin('I. Informational timing');

  await s.check('I1 1,500 files × 8 KiB: adopt + save, repeat, one-file edit, status after', async () => {
    const root = w.fresh('perf');
    for (let i = 0; i < 1500; i++) put(root, `pages/p${i % 30}/f${i}.txt`, randomBytes(8192, i + 1));
    const repo = await adopt(c, root, 'Perf');
    const t0 = performance.now();
    const first = await repo.save({});
    const tFirst = performance.now() - t0;
    const t1 = performance.now();
    await rejectsWith(() => repo.save({}), 'NO_CHANGES', 'repeat');
    const tRepeat = performance.now() - t1;
    put(root, 'pages/p1/f1.txt', randomBytes(8192, 99999));
    const t2 = performance.now();
    await repo.save({});
    const tEdit = performance.now() - t2;
    const t3 = performance.now();
    const st = ext.status(root);
    const tStatus = performance.now() - t3;
    eq(st, '', 'git status');
    const n = walkFiles(root).filter((f) => !f.includes('/.git/')).length;
    s.observe('I1 timing (ms)', { files: n, firstSave: Math.round(tFirst), repeatNoChanges: Math.round(tRepeat), oneFileEdit: Math.round(tEdit), externalGitStatusAfter: Math.round(tStatus), bytes: first.stats.bytes });
  });

  await s.check('I2 20,000 untracked files under node_modules (not in .gitignore) do not slow saves down', async () => {
    const root = designFixture(w, ext, 'nm');
    const repo = await adopt(c, root);
    await repo.save({});
    const t0 = performance.now();
    put(root, 'index.html', 'edit 1\n');
    await repo.save({});
    const plain = performance.now() - t0;
    for (let d = 0; d < 200; d++) for (let f = 0; f < 100; f++) put(root, `node_modules/pkg${d}/f${f}.js`, 'x\n');
    const t1 = performance.now();
    put(root, 'index.html', 'edit 2\n');
    await repo.save({});
    const withNm = performance.now() - t1;
    const tree = ext.lsTree(root);
    assert(!tree.some((p) => p.startsWith('node_modules/')), 'node_modules never enters the tree');
    s.observe('I2 save with / without 20k untracked node_modules files (ms)', { without: Math.round(plain), with: Math.round(withNm) });
  });
}

function hashOf(ext: Ext, w: Work, content: string): string {
  const tmp = join(w.dir, `hash-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content);
  const oid = ext.git(w.dir, ['hash-object', '--no-filters', tmp]).trim();
  rmSync(tmp);
  return oid;
}

