import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, CONFIG_FILE } from './config.ts';
import { trace, spawnGit, sanitizedEnv } from './git.ts';
import { DesignRepo } from './repo.ts';
import { classify, cloneFromRemote, fetchRemote, pull, pushBranch, type Credential, type RemoteBinding } from './sync.ts';
import { startCanary, startGitServer } from './testserver.ts';
import { assert, designFixture, eq, put, read, rejectsWith, walkFiles, type Suite } from './harness.ts';
import type { Ctx } from './tests-local.ts';

const NET = { allowHttp: true } as const;

function tokenInTree(dir: string, token: string): string[] {
  const hits: string[] = [];
  for (const f of walkFiles(dir)) {
    try {
      if (statSync(f).size > 50_000_000) continue;
      if (readFileSync(f).includes(token)) hits.push(f);
    } catch {
      /* unreadable */
    }
  }
  return hits;
}

export async function runSyncTests(c: Ctx): Promise<void> {
  const { w, ext, rt, s } = c;
  const token = `dt_test_${randomBytes(18).toString('hex')}`;
  const cred: Credential = { username: 'x-access-token', token };
  const serverRoot = w.fresh('server');
  const server = await startGitServer({ projectRoot: serverRoot, username: cred.username, token });
  const basicHeader = `Authorization: Basic ${Buffer.from(`${cred.username}:${token}`).toString('base64')}`;
  let counter = 0;

  const newRemote = (): { binding: RemoteBinding; bare: string } => {
    const name = `proj-${counter++}.git`;
    const bare = join(serverRoot, name);
    ext.git(serverRoot, ['init', '-q', '--bare', '-b', 'main', name]);
    ext.git(bare, ['config', 'http.receivepack', 'true']);
    ext.git(bare, ['config', 'receive.denyNonFastForwards', 'true']);
    return { binding: { url: `${server.url}/${name}`, branch: 'main' }, bare };
  };
  const serverTip = (bare: string): string => ext.try(bare, ['rev-parse', '--verify', '-q', 'refs/heads/main']).out.trim();

  async function pair(label: string): Promise<{ a: DesignRepo; aRoot: string; b: DesignRepo; bRoot: string; binding: RemoteBinding; bare: string; dataB: string }> {
    const { binding, bare } = newRemote();
    const aRoot = designFixture(w, ext, `${label}-a`);
    const a = await DesignRepo.adopt(rt, w.dataDir, aRoot, { name: label, entryFiles: ['index.html'] });
    await a.save({ name: 'Baseline' });
    await pushBranch(a, binding, cred, NET);
    const dataB = w.fresh(`${label}-dataB`);
    const bRoot = join(w.fresh(`${label}-b`), 'clone');
    const b = await cloneFromRemote(rt, dataB, bRoot, binding, cred, NET);
    return { a, aRoot, b, bRoot, binding, bare, dataB };
  }

  try {
    s.begin('F. Remote sync through an authenticated HTTP remote (stand-in for GitHub)');

    await s.check('F1 push; an engineer’s plain `git clone` reads the design; wrong token and dead host are mapped, not leaked', async () => {
      const { binding, bare } = newRemote();
      const aRoot = designFixture(w, ext, 'f1');
      const a = await DesignRepo.adopt(rt, w.dataDir, aRoot, { name: 'F1', entryFiles: ['index.html'] });
      const r = await a.save({ name: 'Baseline' });
      eq(await classify(a, binding), 'no-remote-branch', 'before any fetch');
      eq(await fetchRemote(a, binding, cred, NET), null, 'empty remote has no branch');
      const p = await pushBranch(a, binding, cred, NET);
      eq(p.created, true, 'branch created');
      eq(serverTip(bare), r.commit, 'server has our tip');
      const first = server.requests.find((q) => q.path.startsWith(`/${binding.url.split('/').pop()}`));
      assert(first && first.authorized === false, 'first request is anonymous and gets a 401, then credentials are supplied through askpass');
      assert(server.requests.some((q) => q.authorized), 'an authorized request followed');

      const eng = join(w.fresh('engineer'), 'clone');
      await ext.gitAsync(w.dir, ['-c', `http.extraHeader=${basicHeader}`, 'clone', '-q', binding.url, eng]);
      eq(ext.status(eng), '', 'engineer clone: git status');
      assert(existsSync(join(eng, CONFIG_FILE)) && existsSync(join(eng, 'index.html')), 'engineer sees the design and the config');
      assert(ext.git(eng, ['log', '--format=%s']).includes('engineer: initial design'), 'engineer sees the full history including their own commits');

      const before = serverTip(bare);
      put(aRoot, 'index.html', 'edit\n');
      await a.save({});
      await rejectsWith(() => pushBranch(a, binding, { username: cred.username, token: 'wrong-token' }, NET), 'AUTH_REQUIRED', 'wrong token');
      eq(serverTip(bare), before, 'server unchanged after rejected push');
      await rejectsWith(() => pushBranch(a, { url: 'http://127.0.0.1:1/x.git', branch: 'main' }, cred, NET), 'NETWORK_UNAVAILABLE', 'dead host');
      put(aRoot, 'index.html', 'edit offline\n');
      await a.save({}); // saving never needs the network
    });

    await s.check('F2 the token never reaches .git, the data dir, argv, git output or the temp dir', async () => {
      const { binding } = newRemote();
      const aRoot = designFixture(w, ext, 'f2');
      const a = await DesignRepo.adopt(rt, w.dataDir, aRoot, { name: 'F2', entryFiles: ['index.html'] });
      await a.save({});
      const cfgBefore = readFileSync(join(aRoot, '.git', 'config'), 'utf8');
      trace.enabled = true;
      trace.argv.length = 0;
      trace.output.length = 0;
      await pushBranch(a, binding, cred, NET);
      await fetchRemote(a, binding, cred, NET);
      trace.enabled = false;
      eq(tokenInTree(join(aRoot, '.git'), token), [], 'token in .git');
      eq(tokenInTree(w.dataDir, token), [], 'token in data dir');
      assert(!trace.argv.some((argv) => argv.some((x) => x.includes(token))), 'token in any git argv');
      assert(!trace.output.some((o) => o.includes(token)), 'token in any git stdout/stderr');
      eq(readFileSync(join(aRoot, '.git', 'config'), 'utf8'), cfgBefore, '.git/config unchanged by push and fetch');
      const tmp = join(w.dataDir, 'tmp');
      eq(existsSync(tmp) ? readdirSync(tmp) : [], [], 'ephemeral git dirs (with the askpass script and secret) removed');
      s.observe('F2 git calls traced', trace.argv.length);
    });

    await s.check('F3 a repo whose config redirects traffic (insteadOf, proxy, extraHeader, credential helper) cannot capture the token', async () => {
      const { binding } = newRemote();
      const aRoot = designFixture(w, ext, 'f3');
      const a = await DesignRepo.adopt(rt, w.dataDir, aRoot, { name: 'F3', entryFiles: ['index.html'] });
      await a.save({});
      const canary = await startCanary({ challenge: true });
      const marks = w.fresh('f3marks');
      const cfg = (k: string, v: string) => ext.git(aRoot, ['config', '--local', k, v]);
      cfg(`url.${canary.url}/.insteadOf`, `${server.url}/`);
      cfg('http.proxy', canary.url);
      cfg('http.extraHeader', 'X-Evil: 1');
      cfg('credential.helper', `!touch ${marks}/ran-credential; echo username=evil; echo password=evil`);
      cfg('core.sshCommand', `touch ${marks}/ran-ssh`);
      try {
        put(aRoot, 'index.html', 'f3 edit\n');
        await a.save({});
        const before = server.requests.length;
        await pushBranch(a, binding, cred, NET);
        assert(server.requests.length > before, 'traffic reached the real server');
        assert(server.requests.slice(before).every((q) => q.headers['x-evil'] === undefined), 'the repo’s extraHeader was not sent');
        eq(canary.hits, [], 'nothing reached the redirect target');
        eq(readdirSync(marks), [], 'credential helper and ssh command never ran');

        // Control: through the repo's own config a bare insteadOf is enough for
        // the token to be handed to the attacker (helper and proxy removed so the
        // askpass credential is the one that gets asked for).
        ext.git(aRoot, ['config', '--local', '--unset', 'credential.helper']);
        ext.git(aRoot, ['config', '--local', '--unset', 'http.proxy']);
        put(aRoot, 'index.html', 'f3 edit 2\n');
        await a.save({});
        const t = await pushBranch(a, binding, cred, { ...NET, useRepoConfig: true }).then(
          () => 'push succeeded',
          (e: Error) => `push failed: ${e.message.slice(0, 80)}`,
        );
        assert(canary.creds.some((x) => x.includes(token)), `control: with the repo's config honored the real token reached the canary (${t})`);
        s.observe('F3 control', `canary saw ${canary.hits.length} request(s); credentials delivered to it: ${canary.creds.length}`);
      } finally {
        await canary.close();
      }
    });

    await s.check('F4 open a project from the remote on a second machine, edit, push; first machine pulls with a fast-forward', async () => {
      const p = await pair('f4');
      const cfgA = parseConfig(readFileSync(join(p.aRoot, CONFIG_FILE)));
      const cfgB = parseConfig(readFileSync(join(p.bRoot, CONFIG_FILE)));
      eq(cfgB.projectId, cfgA.projectId, 'binding reconstructed from the repo: same projectId');
      eq(cfgB.entryFiles, cfgA.entryFiles, 'entry files travel with the repo');
      eq(ext.lsTree(p.bRoot), ext.lsTree(p.aRoot), 'same tree on both machines');
      eq(ext.status(p.bRoot), '', 'machine B git status');
      assert(ext.git(p.bRoot, ['config', '--get', 'remote.origin.url']).trim() === p.binding.url, 'origin configured for ordinary Git tools');
      put(p.bRoot, 'index.html', '<h1>from machine B</h1>\n');
      const rb = await p.b.save({ name: 'B edit' });
      await pushBranch(p.b, p.binding, cred, NET);
      eq(serverTip(p.bare), rb.commit, 'server has B’s version');
      const res = await pull(p.a, p.binding, cred, NET);
      eq(res.relation, 'behind', 'A was behind');
      eq(res.fastForwarded, true, 'fast-forwarded');
      eq(read(p.aRoot, 'index.html'), '<h1>from machine B</h1>\n', 'working file updated');
      eq(ext.head(p.aRoot), rb.commit, 'A tip is B’s commit');
      eq(ext.status(p.aRoot), '', 'machine A git status');
      eq(await classify(p.a, p.binding), 'equal', 'in sync');
      for (const r of [p.aRoot, p.bRoot]) {
        assert(ext.try(r, ['fsck', '--strict', '--no-dangling']).ok, `git fsck after network operations (${r.slice(-12)})`);
        eq(readdirSync(join(r, '.git', 'objects')).filter((n) => n.startsWith('incoming') || n.startsWith('tmp_')), [], 'no leftover temporary objects');
      }
    });

    await s.check('F5 diverged histories: classified, refused both ways, nothing changed anywhere', async () => {
      const p = await pair('f5');
      put(p.aRoot, 'styles.css', 'A side\n');
      const ra = await p.a.save({ name: 'A side' });
      put(p.bRoot, 'notes.txt', 'B side\n');
      const rb = await p.b.save({ name: 'B side' });
      await pushBranch(p.b, p.binding, cred, NET);
      await fetchRemote(p.a, p.binding, cred, NET);
      eq(await classify(p.a, p.binding), 'diverged', 'classified');
      const filesBefore = read(p.aRoot, 'styles.css');
      await rejectsWith(() => pull(p.a, p.binding, cred, NET), 'REMOTE_DIVERGED', 'pull');
      await rejectsWith(() => pushBranch(p.a, p.binding, cred, NET), 'REMOTE_DIVERGED', 'push');
      eq(serverTip(p.bare), rb.commit, 'server still has B');
      eq(ext.head(p.aRoot), ra.commit, 'A tip unchanged');
      eq(read(p.aRoot, 'styles.css'), filesBefore, 'A files unchanged');
      eq(ext.status(p.aRoot), '', 'A git status');
    });

    await s.check('F6 behind with unsaved work: UNSAVED_CHANGES, files untouched; after saving it is diverged, never silently merged', async () => {
      const p = await pair('f6');
      put(p.bRoot, 'notes.txt', 'B pushes\n');
      await p.b.save({});
      await pushBranch(p.b, p.binding, cred, NET);
      put(p.aRoot, 'styles.css', 'unsaved on A\n');
      await rejectsWith(() => pull(p.a, p.binding, cred, NET), 'UNSAVED_CHANGES', 'pull with unsaved work');
      eq(read(p.aRoot, 'styles.css'), 'unsaved on A\n', 'unsaved work untouched');
      await p.a.save({});
      await rejectsWith(() => pull(p.a, p.binding, cred, NET), 'REMOTE_DIVERGED', 'after saving');
    });

    await s.check('F7 pull while another Git holds index.lock: LOCKED before any file is touched; works once free', async () => {
      const p = await pair('f7');
      put(p.bRoot, 'notes.txt', 'B pushes\n');
      await p.b.save({});
      await pushBranch(p.b, p.binding, cred, NET);
      await fetchRemote(p.a, p.binding, cred, NET);
      const tipBefore = ext.head(p.aRoot);
      const notesBefore = read(p.aRoot, 'notes.txt');
      const { writeFile, rm } = await import('node:fs/promises');
      await writeFile(join(p.aRoot, '.git', 'index.lock'), '');
      await rejectsWith(() => pull(p.a, p.binding, cred, NET), 'LOCKED', 'pull with lock held');
      eq(ext.head(p.aRoot), tipBefore, 'tip unchanged');
      eq(read(p.aRoot, 'notes.txt'), notesBefore, 'files unchanged');
      await rm(join(p.aRoot, '.git', 'index.lock'));
      eq((await pull(p.a, p.binding, cred, NET)).fastForwarded, true, 'pull works once the lock is gone');
      eq(ext.status(p.aRoot), '', 'git status');
    });

    await s.check('F8 the trimmed M0 Git build cannot speak http(s) at all; the full build can', async () => {
      const { binding } = newRemote();
      const trimmed = resolve(dirname(fileURLToPath(import.meta.url)), '../../m0/core/build/git');
      if (!existsSync(join(trimmed, 'bin', 'git'))) return 'trimmed build not present; skipped';
      const rtTrim = { ...rt, gitPath: join(trimmed, 'bin', 'git'), execPath: join(trimmed, 'libexec', 'git-core') };
      const env = (r: typeof rt) => sanitizedEnv(r, { GIT_ALLOW_PROTOCOL: 'http:https', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: basicHeader.replace('Authorization: ', 'Authorization: ') });
      const bad = await spawnGit(rtTrim, ['ls-remote', binding.url], w.dir, env(rtTrim), { allowExitCodes: [128, 1] });
      const good = await spawnGit(rt, ['ls-remote', binding.url], w.dir, env(rt), { allowExitCodes: [128, 1] });
      assert(bad.exitCode !== 0, 'trimmed build fails');
      eq(good.exitCode, 0, 'full build succeeds');
      s.observe('F8 trimmed build error', bad.stderr.trim().split('\n').slice(0, 2).join(' / '));
    });

    if (process.env['SPIKE_TLS_CHECK'] === '1') {
      await s.check('F9 bundled Git verifies real TLS (read-only ls-remote of a public repo)', async () => {
        const r = await spawnGit(rt, ['ls-remote', 'https://github.com/git/git.git', 'HEAD'], w.dir, sanitizedEnv(rt, { GIT_ALLOW_PROTOCOL: 'https' }), { timeoutMs: 30_000 });
        assert(/^[0-9a-f]{40}\tHEAD/.test(r.stdout), `unexpected output: ${r.stdout.slice(0, 80)}`);
        return 'TLS handshake and certificate verification worked';
      });
    }
  } finally {
    trace.enabled = false;
    await server.close();
  }
}

export type { Suite };
