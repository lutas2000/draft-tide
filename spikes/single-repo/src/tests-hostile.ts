import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, parseConfig } from './config.ts';
import { DesignRepo } from './repo.ts';
import { probeRepo } from './probe.ts';
import { assert, del, designFixture, eq, put, read, rejectsWith } from './harness.ts';
import type { Ctx } from './tests-local.ts';

const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase',
  'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite', 'reference-transaction', 'post-index-change', 'fsmonitor-watchman', 'push-to-checkout',
];

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// A repository set up the way a hostile clone, a careless colleague or an old
// tool could leave it: every hook present, programs wired into config keys.
// Whatever runs touches a marker file, so "nothing ran" is directly checkable.
function makeHostile(c: Ctx, root: string, marks: string): { hooksPath: string } {
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  for (const h of HOOKS) script(join(root, '.git', 'hooks', h), `touch "${marks}/hook-${h}"`);
  const hooksPath = join(c.w.fresh('hostile-hooks'));
  for (const h of HOOKS) script(join(hooksPath, h), `touch "${marks}/hookspath-${h}"`);
  const mark = (name: string) => script(join(marks, `${name}.sh`), `touch "${marks}/ran-${name}"`);
  const cfg = (k: string, v: string) => c.ext.git(root, ['config', '--local', k, v]);
  cfg('core.hooksPath', hooksPath);
  cfg('core.fsmonitor', mark('fsmonitor'));
  cfg('core.sshCommand', mark('ssh'));
  cfg('core.pager', mark('pager'));
  cfg('core.editor', mark('editor'));
  cfg('core.askPass', mark('askpass'));
  cfg('core.alternateRefsCommand', mark('altrefs'));
  cfg('credential.helper', `!touch "${marks}/ran-credential"`);
  cfg('gpg.program', mark('gpg'));
  cfg('commit.gpgsign', 'true');
  cfg('gc.auto', '1');
  cfg('gc.autoDetach', 'false');
  cfg('diff.external', mark('diffext'));
  const hostileIncl = join(marks, 'included.cfg');
  writeFileSync(hostileIncl, `[core]\n\tfsmonitor = ${mark('fsmonitor-include')}\n`);
  cfg('include.path', hostileIncl);
  // An exclude file that hides everything: a user's git would then ignore every new file.
  const hide = join(marks, 'hide-all');
  writeFileSync(hide, '*\n');
  cfg('core.excludesFile', hide);
  return { hooksPath };
}

function markers(marks: string): string[] {
  return readdirSync(marks).filter((n) => n.startsWith('hook-') || n.startsWith('hookspath-') || n.startsWith('ran-')).sort();
}

export async function runHostileTests(c: Ctx): Promise<void> {
  const { w, ext, rt, s } = c;

  s.begin('D. A repo whose own config and hooks are hostile');

  await s.check('D1 every operation (adopt, save, restore, recover, probe) runs none of the repo’s hooks or configured programs', async () => {
    const root = designFixture(w, ext, 'hostile');
    const marks = w.fresh('marks');
    makeHostile(c, root, marks);
    const probe = await probeRepo(rt, root);
    assert(probe.dangerousConfigKeys.includes('core.fsmonitor') && probe.dangerousConfigKeys.includes('core.hookspath'), 'probe reports the hazardous keys');
    assert(probe.hooks.includes('reference-transaction'), 'probe reports the hooks');
    eq(probe.blockers, [], 'hooks and config are warnings, not blockers');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Hostile', entryFiles: ['index.html'] });
    put(root, 'new-ignored-by-user-excludes.html', 'hidden by the hostile excludesFile\n');
    const base = await repo.save({ name: 'Baseline' });
    assert(ext.lsTree(root).includes('new-ignored-by-user-excludes.html'), 'the repo’s core.excludesFile did not hide new files from the snapshot');
    put(root, 'index.html', '<h1>v2</h1>\n');
    await repo.save({ name: 'v2' });
    put(root, 'styles.css', 'unsaved\n');
    await repo.applyRestore(await repo.planRestore(base.commit));
    await repo.recover();
    await repo.history();
    eq(markers(marks), [], 'no hook or configured program ran');
  });

  await s.check('D2 control: the same repo with the command-line overrides removed DOES run its hooks', async () => {
    const root = designFixture(w, ext, 'hostile-control');
    const marks = w.fresh('marks');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Control', entryFiles: ['index.html'] });
    makeHostile(c, root, marks);
    const loose = new DesignRepo(rt, w.dataDir, root, { hardened: false });
    put(root, 'index.html', 'edit\n');
    await loose.save({}).catch(() => undefined); // it may fail on the fake signer; only the markers matter
    const ran = markers(marks);
    assert(ran.length > 0, 'the test setup is live: unhardened Git runs something');
    s.observe('D2 what unhardened Git ran', ran);
    // Same again without core.hooksPath, so the repo's own .git/hooks are the live ones.
    ext.git(root, ['config', '--local', '--unset', 'core.hooksPath']);
    for (const f of readdirSync(marks)) if (f.startsWith('hook')) rmSync(join(marks, f));
    put(root, 'index.html', 'edit again\n');
    await loose.save({}).catch(() => undefined);
    const ran2 = markers(marks);
    assert(ran2.includes('hook-reference-transaction'), `control: the repo's own .git/hooks run when unhardened (${ran2.join(', ')})`);
    s.observe('D2b what unhardened Git ran from .git/hooks', ran2);
    void repo;
  });

  await s.check('D3 attribute-activated filter: refused, and the filter program never runs (while a normal `git add` does run it)', async () => {
    const root = designFixture(w, ext, 'filter');
    const marks = w.fresh('marks');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Filter', entryFiles: ['index.html'] });
    put(root, '.gitattributes', '* filter=evil\n');
    ext.git(root, ['config', '--local', 'filter.evil.clean', `touch "${marks}/ran-clean"; cat`]);
    ext.git(root, ['config', '--local', 'filter.evil.smudge', `touch "${marks}/ran-smudge"; cat`]);
    put(root, 'index.html', 'edit\n');
    const e = await rejectsWith(() => repo.save({}), 'REPO_UNSUPPORTED', 'filter');
    assert(JSON.stringify(e.details).includes('attribute-filter'), 'reason is attribute-filter');
    eq(markers(marks), [], 'probing and refusing ran no filter');
    ext.git(root, ['add', 'index.html']);
    eq(markers(marks), ['ran-clean'], 'control: a normal git add does run the clean filter');
  });

  await s.check('D4 commit signing config in the repo is not honored by our commits', async () => {
    const root = designFixture(w, ext, 'gpg');
    const marks = w.fresh('marks');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Gpg', entryFiles: ['index.html'] });
    ext.git(root, ['config', '--local', 'commit.gpgsign', 'true']);
    ext.git(root, ['config', '--local', 'gpg.program', script(join(marks, 'fake-gpg.sh'), `touch "${marks}/ran-gpg"; exit 1`)]);
    await repo.save({});
    eq(markers(marks), [], 'gpg program never invoked');
    eq(ext.git(root, ['cat-file', '-p', 'HEAD']).includes('gpgsig'), false, 'commit is unsigned');
  });

  s.begin('E. The project config file is untrusted input');

  const base = JSON.stringify({ schemaVersion: 1, projectId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Ok', entryFiles: ['index.html'], excludeDirNames: ['node_modules'], excludeFilePatterns: ['*.log'] });
  const variants: [string, string | Buffer][] = [
    ['entry escapes with ..', base.replace('"index.html"', '"../../etc/passwd"')],
    ['entry is absolute', base.replace('"index.html"', '"/etc/passwd"')],
    ['entry targets .git', base.replace('"index.html"', '".git/config"')],
    ['entry has a backslash', base.replace('"index.html"', '"a\\\\b.html"')],
    ['unknown field', base.replace('"name"', '"command":"rm -rf /","name"')],
    ['schemaVersion 2', base.replace('"schemaVersion":1', '"schemaVersion":2')],
    ['projectId not a uuid', base.replace('7c9e6679-7425-40de-944b-e07fc1f90ae7', 'not-a-uuid')],
    ['name with a newline', base.replace('"Ok"', '"a\\nb"')],
    ['exclude dir with a slash', base.replace('"node_modules"', '"a/b"')],
    ['exclude pattern negation', base.replace('"*.log"', '"!keep"')],
    ['too many entry files', base.replace('["index.html"]', JSON.stringify(Array.from({ length: 20 }, (_, i) => `f${i}.html`)))],
    ['top level array', '[]'],
    ['not JSON', 'nope'],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['oversized', `${base}${' '.repeat(70_000)}`],
  ];

  await s.check(`E1 ${variants.length} malformed or unsafe config files are all rejected as CONFIG_INVALID`, async () => {
    for (const [label, text] of variants) {
      let code = 'accepted';
      try {
        parseConfig(Buffer.isBuffer(text) ? text : Buffer.from(text));
      } catch (e) {
        code = (e as { code?: string }).code ?? 'other';
      }
      if (code !== 'CONFIG_INVALID') throw new Error(`${label}: ${code}`);
    }
    parseConfig(Buffer.from(base));
  });

  await s.check('E2 a bad config blocks saving and leaves the repo alone; missing or symlinked config is refused', async () => {
    const root = designFixture(w, ext, 'cfgbad');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Cfg', entryFiles: ['index.html'] });
    await repo.save({});
    const good = read(root, CONFIG_FILE);
    const tip = ext.head(root);
    put(root, 'index.html', 'edit\n');
    put(root, CONFIG_FILE, base.replace('"index.html"', '"../../etc/passwd"'));
    await rejectsWith(() => repo.save({}), 'CONFIG_INVALID', 'bad config');
    eq(ext.head(root), tip, 'no commit');
    put(root, CONFIG_FILE, good);
    del(root, CONFIG_FILE);
    await rejectsWith(() => repo.save({}), 'PROJECT_NOT_BOUND', 'missing config');
    put(root, 'elsewhere.json', good);
    symlinkSync(join(root, 'elsewhere.json'), join(root, CONFIG_FILE));
    await rejectsWith(() => repo.save({}), 'CONFIG_INVALID', 'symlinked config');
    del(root, CONFIG_FILE);
    put(root, CONFIG_FILE, good);
    await repo.save({});
  });

  await s.check('E3 pathological wildcard patterns cannot stall a save', async () => {
    const root = designFixture(w, ext, 'redos');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Redos', entryFiles: ['index.html'] });
    const cfg = JSON.parse(read(root, CONFIG_FILE)) as { excludeFilePatterns: string[] };
    cfg.excludeFilePatterns.push('*a*a*a*a*a*a*a*a*a*a*a*b', '?*?*?*?*?*?*?*?*?*?*c');
    put(root, CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
    put(root, `${'a'.repeat(120)}.txt`, 'x\n');
    const t = performance.now();
    await repo.save({});
    const ms = performance.now() - t;
    assert(ms < 5000, `took ${Math.round(ms)} ms`);
    return `${Math.round(ms)} ms`;
  });

  await s.check('E4 a .gitignore that lists the config file cannot drop it from snapshots', async () => {
    const root = designFixture(w, ext, 'cfgignored');
    put(root, '.gitignore', `${read(root, '.gitignore')}${CONFIG_FILE}\n`);
    ext.commitAll(root, 'ignore config (mistake)');
    const repo = await DesignRepo.adopt(rt, w.dataDir, root, { name: 'Ignored', entryFiles: ['index.html'] });
    await repo.save({});
    assert(ext.lsTree(root).includes(CONFIG_FILE), 'config is in the tree');
    eq(ext.status(root), '', 'git status');
  });

  void existsSync;
}
