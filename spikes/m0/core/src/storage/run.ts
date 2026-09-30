// M0 storage-strategy validation (ROADMAP §5, TECH_STACK §6.0, M1 §13.1/13.4):
// raw-byte round trip, asset object reuse, history growth over many text
// iterations with a few asset replacements, restore semantics, and a full
// backup restored offline into a new empty destination.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { DtError } from '../shared/errors.ts';
import { Git, gitVersion, resolveGitRuntime } from '../shared/git.ts';
import { exportBackup, importBackup } from './backup.ts';
import { component, generateFixture, makePng, pricingHtml, prng, tokensCss } from './fixtures.ts';
import { DEFAULT_SCOPE_POLICY, findPathCollisions, scan } from './scope.ts';
import { CAPTURE_MODE, ProjectStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spikeDir = resolve(here, '..', '..');
const ITERATIONS = Number(process.env['M0_ITERATIONS'] ?? 50);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = resolve(process.env['M0_WORK_DIR'] ?? join(spikeDir, '.work', `storage-${stamp}`));
const dataDir = join(work, 'data');
const root = join(work, 'design');
const markers = join(work, 'markers');
mkdirSync(markers, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const rssCheckpoints: Record<string, number> = {};
const rss = (label: string) => { rssCheckpoints[label] = Math.round(process.resourceUsage().maxRSS / 1024); };
type Check = { id: string; description: string; pass: boolean; details?: Record<string, unknown> };
const checks: Check[] = [];
function check(id: string, description: string, pass: boolean, details?: Record<string, unknown>): void {
  checks.push(details ? { id, description, pass, details } : { id, description, pass });
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}${details ? '  ' + JSON.stringify(details).slice(0, 300) : ''}`);
}
async function expectCode(code: string, fn: () => Promise<unknown>): Promise<{ pass: boolean; got: string }> {
  try {
    await fn();
    return { pass: false, got: 'success' };
  } catch (e) {
    const got = e instanceof DtError ? e.code : `non-DtError: ${(e as Error).message}`;
    return { pass: got === code, got };
  }
}

type Manifest = Map<string, { sha256: string; mode: string; size: number }>;
// Independent of the store's streaming code path: plain readFile + sha256.
async function liveManifest(dir: string): Promise<Manifest> {
  const s = await scan(dir, DEFAULT_SCOPE_POLICY);
  const m: Manifest = new Map();
  for (const f of s.files) {
    const buf = await readFile(f.abs);
    m.set(f.path, { sha256: createHash('sha256').update(buf).digest('hex'), mode: f.mode, size: buf.length });
  }
  return m;
}
function diffManifests(expected: Manifest, actual: Map<string, { sha256: string; mode: string }>): string[] {
  const out: string[] = [];
  for (const [p, e] of expected) {
    const a = actual.get(p);
    if (!a) out.push(`missing ${p}`);
    else if (a.sha256 !== e.sha256) out.push(`bytes ${p}`);
    else if (a.mode !== e.mode) out.push(`mode ${p}`);
  }
  for (const p of actual.keys()) if (!expected.has(p)) out.push(`extra ${p}`);
  return out;
}
async function dirUsage(dir: string): Promise<{ files: number; logical: number; allocated: number }> {
  let files = 0, logical = 0, allocated = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const n of await readdir(d)) {
      const p = join(d, n);
      const st = await lstat(p);
      if (st.isDirectory()) stack.push(p);
      else {
        files++;
        logical += st.size;
        allocated += st.blocks * 512;
      }
    }
  }
  return { files, logical, allocated };
}
async function countObjects(git: Git): Promise<Record<string, number>> {
  const r = await git.run(['count-objects', '-v']);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const [k, v] = l.split(': '); return [k ?? '', Number(v)]; }));
}
async function gitDirDigest(dir: string): Promise<string> {
  const h = createHash('sha256');
  const stack = [dir];
  const rows: string[] = [];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const n of (await readdir(d)).sort()) {
      const p = join(d, n);
      const st = await lstat(p);
      if (st.isDirectory()) stack.push(p);
      else rows.push(`${p.slice(dir.length)} ${st.size} ${st.mode} ${st.mtimeMs} ${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    }
  }
  h.update(rows.sort().join('\n'));
  return h.digest('hex');
}
const mb = (n: number) => Math.round((n / 1024 / 1024) * 100) / 100;

// ---------------------------------------------------------------- setup
const rt = resolveGitRuntime(dataDir);
const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  env: { node: process.version, platform: process.platform, arch: process.arch, git: await gitVersion(rt), gitSource: rt.source, iterations: ITERATIONS, captureMode: CAPTURE_MODE },
};
console.error(`work dir: ${work}\ngit: ${String((results['env'] as Record<string, unknown>)['git'])} (${rt.source})`);

const fx = generateFixture(root);
results['fixture'] = { files: fx.fileCount, totalMiB: mb(fx.totalBytes), assetMiB: mb(fx.assetBytes), jpegSource: fx.jpegSource, fontSource: fx.fontSource };
console.error(`fixture: ${fx.fileCount} files, ${mb(fx.totalBytes)} MiB (${mb(fx.assetBytes)} MiB assets)`);

// Simulate the designer's own application repo living in the same folder,
// with hostile hooks / filters that a careless Git call would trigger.
const userHome = join(work, 'user-home');
mkdirSync(userHome, { recursive: true });
const userEnv = { PATH: '/usr/bin:/bin', HOME: userHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Designer', GIT_AUTHOR_EMAIL: 'd@example.invalid', GIT_COMMITTER_NAME: 'Designer', GIT_COMMITTER_EMAIL: 'd@example.invalid' };
const ug = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { env: userEnv, stdio: 'pipe' });
ug('init', '-q', '-b', 'main');
ug('add', 'index.html', 'css', 'js', 'pages');
ug('commit', '-q', '-m', 'app repo initial');
writeFileSync(join(root, 'APP_NOTES.md'), 'staged but not committed in the app repo\n');
ug('add', 'APP_NOTES.md');
ug('config', 'filter.evil.clean', `sh -c 'touch ${markers}/filter-clean; cat'`);
ug('config', 'filter.evil.smudge', `sh -c 'touch ${markers}/filter-smudge; cat'`);
ug('config', 'filter.evil.required', 'true');
writeFileSync(join(root, '.gitattributes'), '*.css filter=evil\n*.html filter=evil\n* text=auto eol=crlf\n');
for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction', 'post-index-change']) {
  writeFileSync(join(root, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${markers}/hook-${hook}\n`);
  chmodSync(join(root, '.git', 'hooks', hook), 0o755);
}
const userGitBefore = await gitDirDigest(join(root, '.git'));
// Hostile parent environment: must not leak into Draft Tide's Git.
Object.assign(process.env, {
  GIT_DIR: join(root, '.git'),
  GIT_WORK_TREE: root,
  GIT_INDEX_FILE: join(root, '.git', 'index'),
  GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${join(root, '.git', 'hooks')}' 'filter.evil.clean'='touch ${markers}/env-filter'`,
  GIT_EXTERNAL_DIFF: `touch ${markers}/env-extdiff`,
  GIT_TRACE: join(markers, 'env-trace'),
});

// ---------------------------------------------------------------- baseline + iterations
const store = await ProjectStore.create(dataDir, rt, { root, entryFiles: ['index.html'] });
const scanned = await scan(root, DEFAULT_SCOPE_POLICY);
check('scope.excludes', 'default scope excludes .git, node_modules, .env.local, .DS_Store, *.log', ['.git/', 'node_modules/', '.env.local', '.DS_Store', 'debug.log'].every((p) => scanned.excluded.some((e) => e.path === p)), { excluded: scanned.excluded.map((e) => e.path) });

type Version = { i: number; snapshotId: string; commit: string; manifest: Manifest; ms: number; writeObjectsMs: number; newBlobs: number; newLooseObjects: number; changedFiles: number; repoAllocated: number; captureAttempts: number; stageMs: number; rescanMs: number };
const versions: Version[] = [];
let prevObjects = await countObjects(store.git);
async function save(i: number, name: string, prev: Manifest | null): Promise<Version> {
  const manifest = await liveManifest(root);
  const t = performance.now();
  const r = await store.snapshot({ kind: i === 0 ? 'baseline' : 'manual', origin: 'harness', name });
  const ms = performance.now() - t;
  const objs = await countObjects(store.git);
  let changedFiles = 0;
  for (const [p, e] of manifest) if (!prev || prev.get(p)?.sha256 !== e.sha256 || prev.get(p)?.mode !== e.mode) changedFiles++;
  if (prev) for (const p of prev.keys()) if (!manifest.has(p)) changedFiles++;
  const v: Version = { i, snapshotId: r.snapshotId, commit: r.commit, manifest, ms, writeObjectsMs: r.writeObjectsMs, newBlobs: r.newBlobs, newLooseObjects: (objs['count'] ?? 0) - (prevObjects['count'] ?? 0), changedFiles, repoAllocated: (await dirUsage(store.repoDir)).allocated, captureAttempts: r.capture.attempts, stageMs: r.capture.stageMs, rescanMs: r.capture.rescanMs };
  prevObjects = objs;
  versions.push(v);
  return v;
}

const base = await save(0, 'Baseline', null);
rss('afterBaseline');
console.error(`baseline: ${Math.round(base.ms)} ms, ${base.newLooseObjects} objects, repo ${mb(base.repoAllocated)} MiB`);

const rnd = prng(7);
let prices: [number, number, number] = [9, 29, 99];
const events: Record<number, string> = {};
for (let i = 1; i <= ITERATIONS; i++) {
  const what: string[] = [];
  writeFileSync(join(root, 'css/tokens.css'), tokensCss((210 + i * 7) % 360, 8 + (i % 6)));
  what.push('tokens.css');
  prices = [prices[0] + (i % 2), prices[1] + (i % 3), prices[2] + (i % 5)];
  writeFileSync(join(root, 'pages/pricing.html'), pricingHtml(prices, `Pricing v${i}`));
  what.push('pricing.html');
  for (let k = 0; k < 2; k++) {
    const n = Math.floor(rnd() * 600);
    const rel = `components/group-${String(Math.floor(n / 30)).padStart(2, '0')}/block-${n}.html`;
    if (existsSync(join(root, rel))) {
      writeFileSync(join(root, rel), component(n, `Feature ${n} — iteration ${i}`));
      what.push(rel);
    }
  }
  if (i % 5 === 0) {
    appendFileSync(join(root, 'js/app.js'), `// iteration ${i}\n`);
    what.push('app.js');
  }
  if (i === 12 || i === 25 || i === 38) {
    const target = i === 38 ? 'assets/img/product-3.png' : `assets/img/hero-${i === 12 ? 1 : 2}.png`;
    writeFileSync(join(root, target), i === 38 ? makePng(800, 600, 9000 + i) : makePng(1600, 900, 9000 + i));
    what.push(`REPLACE ${target}`);
    events[i] = `replace ${target}`;
  }
  if (i === 20) {
    writeFileSync(join(root, 'assets/img/hero-4.png'), makePng(1600, 900, 7777));
    what.push('ADD assets/img/hero-4.png');
    events[i] = 'add assets/img/hero-4.png';
  }
  if (i === 30) {
    mkdirSync(join(root, 'components/archive'), { recursive: true });
    renameSync(join(root, 'components/group-05/block-150.html'), join(root, 'components/archive/block-150.html'));
    events[i] = 'rename components/group-05/block-150.html -> components/archive/block-150.html';
  }
  if (i === 33) {
    unlinkSync(join(root, 'assets/icons/icon-299.svg'));
    events[i] = 'delete assets/icons/icon-299.svg';
  }
  if (i === 40) {
    appendFileSync(join(root, 'notes/crlf-notes.txt'), 'line three\r\n');
    events[i] = 'append CRLF line';
  }
  if (i === 45) {
    chmodSync(join(root, 'scripts/build.sh'), 0o644);
    events[i] = 'chmod -x scripts/build.sh (mode-only change)';
  }
  const prev = versions[versions.length - 1] as Version;
  await save(i, `Iteration ${i}`, prev.manifest);
}
rss('afterIterations');
const iters = versions.slice(1);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.error(`iterations: ${iters.length}, avg ${Math.round(avg(iters.map((v) => v.ms)))} ms/save`);

// ---------------------------------------------------------------- checks on history
const noop = await expectCode('NO_CHANGES', () => store.snapshot({ kind: 'manual', origin: 'harness' }));
const headAfterNoop = await store.head();
check('snapshot.no-op', 'unchanged tree returns NO_CHANGES and adds no version', noop.pass && headAfterNoop === versions[versions.length - 1]?.commit, { got: noop.got });

let t0 = performance.now();
let mismatches: string[] = [];
let bytesVerified = 0;
for (const v of versions) {
  const d = await store.digestSnapshot(v.commit);
  mismatches = mismatches.concat(diffManifests(v.manifest, d).map((m) => `v${v.i}: ${m}`));
  for (const e of v.manifest.values()) bytesVerified += e.size;
}
const roundTripMs = performance.now() - t0;
check('bytes.round-trip', `every file of all ${versions.length} versions streams back byte-identical with the same mode`, mismatches.length === 0, { mismatches: mismatches.slice(0, 10), versions: versions.length, verifiedMiB: mb(bytesVerified) });

const edge = versions[0]?.manifest;
check('bytes.edge-cases', 'CRLF, BOM, empty, exec-bit, no-trailing-newline and Unicode-name files are present in baseline', !!edge && ['notes/crlf-notes.txt', 'notes/bom.css', 'notes/empty.txt', 'scripts/build.sh', '設計稿/首頁 草稿.html', 'notes/trailing-no-newline.txt'].every((p) => edge.has(p)) && edge.get('scripts/build.sh')?.mode === '100755');

// Asset reuse: distinct blob OIDs per binary path across all versions.
const trees = await Promise.all(versions.map((v) => store.readTree(v.commit)));
const oidsByPath = new Map<string, Set<string>>();
for (const tr of trees) for (const e of tr) {
  if (!/\.(png|jpe?g|ttf|woff2)$/.test(e.path)) continue;
  let s = oidsByPath.get(e.path);
  if (!s) oidsByPath.set(e.path, (s = new Set()));
  s.add(e.oid);
}
const replaced = new Set(['assets/img/hero-1.png', 'assets/img/hero-2.png', 'assets/img/product-3.png']);
const reuseViolations = [...oidsByPath].filter(([p, s]) => s.size !== (replaced.has(p) ? 2 : 1)).map(([p, s]) => `${p}: ${s.size}`);
check('assets.reuse', `each binary asset is stored once per distinct content across ${versions.length} versions (${oidsByPath.size} asset paths)`, reuseViolations.length === 0, { violations: reuseViolations });
const assetOnlyTextIters = iters.filter((v) => !events[v.i]);
const maxNewObjects = Math.max(...assetOnlyTextIters.map((v) => v.newLooseObjects));
check('assets.text-iteration-cost', 'a text-only iteration adds only changed blobs + changed trees + 1 commit (no asset copies)', assetOnlyTextIters.every((v) => v.newLooseObjects <= v.changedFiles * 4 + 2), { maxNewObjectsPerTextIteration: maxNewObjects, maxChangedFiles: Math.max(...assetOnlyTextIters.map((v) => v.changedFiles)) });
const renameV = versions.find((v) => v.i === 30);
const beforeRename = versions.find((v) => v.i === 29);
if (renameV && beforeRename) {
  const a = trees[versions.indexOf(beforeRename)]?.find((e) => e.path === 'components/group-05/block-150.html')?.oid;
  const b = trees[versions.indexOf(renameV)]?.find((e) => e.path === 'components/archive/block-150.html')?.oid;
  check('assets.rename-reuse', 'a renamed file reuses the same blob', !!a && a === b, { newLooseObjects: renameV.newLooseObjects });
}
const modeV = versions.find((v) => v.i === 45);
const beforeMode = versions.find((v) => v.i === 44);
if (modeV && beforeMode) {
  const a = trees[versions.indexOf(beforeMode)]?.find((e) => e.path === 'scripts/build.sh');
  const b = trees[versions.indexOf(modeV)]?.find((e) => e.path === 'scripts/build.sh');
  check('bytes.mode-only', 'exec-bit change is a new tree entry mode with the same blob', !!a && !!b && a.oid === b.oid && a.mode === '100755' && b.mode === '100644');
}

// Storage growth.
const loose = await dirUsage(store.repoDir);
const naiveCopies = versions.reduce((acc, v) => acc + [...v.manifest.values()].reduce((a, e) => a + e.size, 0), 0);
const packedCopy = join(work, 'packed-copy.git');
cpSync(store.repoDir, packedCopy, { recursive: true });
const pg = new Git(rt, packedCopy);
t0 = performance.now();
await pg.run(['repack', '-a', '-d', '-q']);
const repackMs = performance.now() - t0;
const packed = await dirUsage(packedCopy);
const growth = {
  versions: versions.length,
  designMiB: mb(fx.totalBytes),
  naiveFullCopiesMiB: mb(naiveCopies),
  looseRepoMiB: mb(loose.allocated),
  looseRepoFiles: loose.files,
  packedRepoMiB: mb(packed.allocated),
  repackMs: Math.round(repackMs),
  baselineRepoMiB: mb(base.repoAllocated),
  perTextIterationKiB: Math.round(avg(assetOnlyTextIters.map((v, idx) => { const prev = versions[versions.indexOf(v) - 1]; return prev ? (v.repoAllocated - prev.repoAllocated) / 1024 : 0; }).slice(1))),
  perAssetReplacementMiB: [12, 25, 38, 20].map((i) => { const v = versions.find((x) => x.i === i); const p = versions.find((x) => x.i === i - 1); return v && p ? mb(v.repoAllocated - p.repoAllocated) : null; }),
};
results['growth'] = growth;
check('storage.growth', 'history of all versions is far smaller than full copies (content-addressed reuse)', loose.allocated < naiveCopies / 5, growth);

// Adversarial / edge behaviours on small side projects.
const casHead = await store.head();
const cas = await expectCode('GIT_FAILED', () => store.git.run(['update-ref', 'refs/heads/main', versions[0]?.commit ?? '', '1'.repeat(40)]));
check('ref.cas', 'update-ref with a stale expected-old-OID is rejected and main is unchanged', cas.pass && (await store.head()) === casHead, { got: cas.got });

const collisions = findPathCollisions(['A.txt', 'a.txt', 'b/C.css', 'B/c.css', 'café.html', 'café.html', 'ok.txt']);
check('paths.collisions', 'case / Unicode-normalization collisions are detected before write-back', collisions.length >= 3 && !collisions.some((g) => g.includes('ok.txt')), { collisions });

const linkRoot = join(work, 'symlink-project');
mkdirSync(linkRoot, { recursive: true });
writeFileSync(join(linkRoot, 'index.html'), '<h1>x</h1>\n');
symlinkSync('../design', join(linkRoot, 'shared'));
const linkStore = await ProjectStore.create(dataDir, rt, { root: linkRoot, entryFiles: ['index.html'] });
const sym = await expectCode('UNSUPPORTED_ENTRY', () => linkStore.snapshot({ kind: 'baseline', origin: 'harness' }));
check('scope.symlink', 'a symlink inside scope stops the save with UNSUPPORTED_ENTRY (no silent skip)', sym.pass, { got: sym.got });

const busyRoot = join(work, 'busy-project');
mkdirSync(busyRoot, { recursive: true });
writeFileSync(join(busyRoot, 'index.html'), '<h1>busy</h1>\n');
writeFileSync(join(busyRoot, 'live.css'), 'x'.repeat(2 * 1024 * 1024));
const busyStore = await ProjectStore.create(dataDir, rt, { root: busyRoot, entryFiles: ['index.html'] });
await busyStore.snapshot({ kind: 'baseline', origin: 'harness' });
const busyHead = await busyStore.head();
// Continuous writer: every write is one complete 2 MiB generation "<n>|yyy…".
const writer = spawn(process.execPath, ['-e', `const fs=require('fs');const f=${JSON.stringify(join(busyRoot, 'live.css'))};let i=0;const body='y'.repeat(2*1024*1024);for(;;){fs.writeFileSync(f, (i++)+'|'+body)}`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 150));
const busy = await expectCode('SOURCE_BUSY', () => busyStore.snapshot({ kind: 'manual', origin: 'harness' }));
writer.kill('SIGKILL');
let busyDetail: Record<string, unknown> = { got: busy.got };
let busyOk = busy.pass && (await busyStore.head()) === busyHead;
if (!busy.pass && busy.got === 'success') {
  // Optimistic capture may legitimately land between two writes; then the
  // saved bytes must be one complete, untorn generation.
  const newHead = (await busyStore.head()) as string;
  const d = await busyStore.digestSnapshot(newHead);
  const e = (await busyStore.readTree(newHead)).find((x) => x.path === 'live.css');
  const blob = e ? (await busyStore.git.run(['cat-file', 'blob', e.oid], { maxOutputBytes: 8 << 20 })).stdoutBuffer.toString('latin1') : '';
  const m = /^(\d+)\|(y+)$/.exec(blob);
  busyOk = !!m && m[2]?.length === 2 * 1024 * 1024 && d.size === 2;
  busyDetail = { got: 'success-between-writes', generation: m?.[1], untorn: busyOk };
}
check('capture.source-busy', 'a continuously rewritten file ends in SOURCE_BUSY after 3 retries (history unchanged), or a complete untorn generation is saved', busyOk, busyDetail);

// Two store instances on one repo (what the single Engine prevents): CAS
// must still make one lose rather than silently overwrite.
const twin = ProjectStore.open(dataDir, rt, store.cfg);
writeFileSync(join(root, 'css/tokens.css'), tokensCss(1, 1));
const headBeforeRace = await store.head();
const histLenBeforeRace = (await store.history()).length;
const race = await Promise.allSettled([store.snapshot({ kind: 'manual', origin: 'harness', name: 'race A' }), twin.snapshot({ kind: 'manual', origin: 'harness', name: 'race B' })]);
const raceCodes = race.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason instanceof DtError ? r.reason.code : 'error'));
const raceHist = await store.history();
const okCommits = race.flatMap((r) => (r.status === 'fulfilled' ? [r.value.commit] : []));
check('ref.race', 'two unsynchronised writers: CAS rejects the loser (HISTORY_CHANGED/NO_CHANGES), no lost or forked commits', okCommits.length >= 1 && okCommits.every((c) => raceHist.some((h) => h.commit === c)) && raceHist.length === histLenBeforeRace + okCommits.length && raceHist[okCommits.length]?.commit === headBeforeRace, { outcomes: raceCodes });

// ---------------------------------------------------------------- restore
const target = versions[0] as Version;
writeFileSync(join(root, 'css/tokens.css'), tokensCss(333, 3)); // unsaved change
const plan1 = await store.planRestore(target.snapshotId);
writeFileSync(join(root, 'pages/pricing.html'), pricingHtml([1, 2, 3], 'Edited after plan'));
const stale = await expectCode('PLAN_STALE', () => store.applyRestore(plan1, 'harness'));
check('restore.stale', 'a file changed after planning -> PLAN_STALE, nothing written', stale.pass, { got: stale.got });

writeFileSync(join(root, 'notes/new-idea.txt'), 'never saved\n');
const plan2 = await store.planRestore(target.snapshotId);
const untracked = await expectCode('UNTRACKED_FILES', () => store.applyRestore(plan2, 'harness'));
check('restore.untracked', 'a never-saved file that restore would delete blocks with UNTRACKED_FILES', untracked.pass && plan2.untracked.includes('notes/new-idea.txt'), { got: untracked.got, untracked: plan2.untracked });
unlinkSync(join(root, 'notes/new-idea.txt'));

const beforeRestore = await liveManifest(root);
const histBefore = await store.history();
const plan3 = await store.planRestore(target.snapshotId);
t0 = performance.now();
const restored = await store.applyRestore(plan3, 'harness');
const restoreMs = performance.now() - t0;
const afterRestore = await liveManifest(root);
const histAfter = await store.history();
const restoreDiff = diffManifests(target.manifest, afterRestore);
rss('afterRestore');
check('restore.bytes', 'after restore every scoped file equals the baseline bytes / modes', restoreDiff.length === 0, { diff: restoreDiff.slice(0, 10), writes: plan3.writes.length, deletes: plan3.deletes.length, ms: Math.round(restoreMs) });
const protection = restored.protection;
const protDigest = protection ? await store.digestSnapshot(protection.commit) : null;
check('restore.protection', 'unsaved work was saved first as a pre-restore version, byte-exact', !!protDigest && diffManifests(beforeRestore, protDigest).length === 0);
check('restore.appends', 'restore appends [pre-restore, restore]; no earlier version is lost', histAfter.length === histBefore.length + 2 && histBefore.every((h) => histAfter.some((a) => a.commit === h.commit)) && histAfter[0]?.meta.kind === 'restore' && histAfter[0]?.meta.restoreOf === target.snapshotId && histAfter[1]?.meta.kind === 'pre-restore');
check('restore.no-dt-temp', 'no temporary files left in the design folder', !(await scan(root, { ...DEFAULT_SCOPE_POLICY, excludeFilePatterns: [] })).files.some((f) => f.path.includes('.dt-tmp-')));

const userGitAfter = await gitDirDigest(join(root, '.git'));
const markerFiles = await readdir(markers);
check('user-repo.untouched', "the designer's own .git (HEAD, refs, index, config, hooks) is byte-identical after all saves and the restore", userGitBefore === userGitAfter);
check('git.hardening', 'no hook, filter, external diff or leaked GIT_* env ran (marker dir empty)', markerFiles.length === 0, { markers: markerFiles });

console.error('fsck…');
const fsck = await store.fsck();
check('git.fsck', 'git fsck --full --strict is clean', fsck === '', { output: fsck.slice(0, 300) });

// ---------------------------------------------------------------- backup / import
const backupFile = join(work, 'aurora.drafttide');
t0 = performance.now();
const exp = await exportBackup(store, backupFile, 'Aurora pricing');
const exportMs = performance.now() - t0;
const exp2 = await expectCode('PATH_OUTSIDE_ROOT', () => exportBackup(store, backupFile, 'Aurora pricing'));
check('backup.no-clobber', 'exporting onto an existing file is refused (no silent overwrite)', exp2.pass, { got: exp2.got });

const allMessages = (await store.history()).map((h) => h.meta).map((m) => JSON.stringify(m)).join('\n');
const manifestText = JSON.stringify(exp.manifest);
const secrets = [root, dataDir, work, homedir(), userInfo().username].filter((s) => s.length >= 3);
const leaks = secrets.filter((s) => allMessages.includes(s) || manifestText.includes(s));
check('privacy.metadata', 'commit metadata and backup manifest contain no absolute paths, home dir or user name', leaks.length === 0, { leaks });

const importData = join(work, 'import-data');
const importDest = join(work, 'restored-design');
mkdirSync(importData, { recursive: true });
t0 = performance.now();
const imp = await importBackup(backupFile, importData, resolveGitRuntime(importData), importDest);
const importMs = performance.now() - t0;
rss('afterImport');
const impHist = await imp.store.history();
check('backup.identities', 'imported history keeps every snapshot id and commit id', impHist.length === exp.manifest.snapshots.length && exp.manifest.snapshots.every((s, i) => impHist[i]?.commit === s.commit && impHist[i]?.meta.snapshotId === s.snapshotId));
let impMismatch: string[] = [];
for (const v of versions) impMismatch = impMismatch.concat(diffManifests(v.manifest, await imp.store.digestSnapshot(v.commit)).map((m) => `v${v.i}: ${m}`));
check('backup.all-versions', `all ${versions.length} versions recoverable byte-exact from the backup alone`, impMismatch.length === 0, { mismatches: impMismatch.slice(0, 10) });
const destManifest = await liveManifest(importDest);
check('backup.materialize', 'latest version materialized into the new empty folder byte-exact', diffManifests(afterRestore, destManifest).length === 0, { files: imp.materializedFiles });
writeFileSync(join(importDest, 'css/tokens.css'), tokensCss(42, 4));
const cont = await imp.store.snapshot({ kind: 'manual', origin: 'harness', name: 'Continue after import' });
check('backup.continue', 'saving continues on top of imported history', (await imp.store.history())[0]?.parents[0] === impHist[0]?.commit, { snapshotId: cont.snapshotId });

// Negative import cases.
async function readZip(file: string): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return rej(err);
      const out: { name: string; data: Buffer }[] = [];
      zf.on('entry', (e: yauzl.Entry) => zf.openReadStream(e, (er, rs) => {
        if (er || !rs) return rej(er);
        const bufs: Buffer[] = [];
        rs.on('data', (b: Buffer) => bufs.push(b));
        rs.on('end', () => { out.push({ name: e.fileName, data: Buffer.concat(bufs) }); zf.readEntry(); });
      }));
      zf.on('end', () => res(out));
      zf.readEntry();
    });
  });
}
async function writeZip(file: string, entries: { name: string; data: Buffer }[]): Promise<void> {
  const z = new yazl.ZipFile();
  for (const e of entries) z.addBuffer(e.data, e.name);
  z.end();
  const bufs: Buffer[] = [];
  for await (const c of z.outputStream) bufs.push(c as Buffer);
  writeFileSync(file, Buffer.concat(bufs));
}
const orig = await readZip(backupFile);
const neg: Record<string, string> = {};
const tryImport = async (label: string, file: string, code: string, dest?: string) => {
  const d = dest ?? join(work, `neg-dest-${label}`);
  const r = await expectCode(code, () => importBackup(file, join(work, `neg-data-${label}`), resolveGitRuntime(join(work, `neg-data-${label}`)), d));
  neg[label] = r.got;
  return r.pass;
};
const tampered = orig.map((e) => (e.name === 'history.bundle' ? { ...e, data: Buffer.from(e.data.map((b, i) => (i === Math.floor(e.data.length / 2) ? b ^ 0xff : b))) } : e));
await writeZip(join(work, 'tampered.drafttide'), tampered);
const t1 = await tryImport('tampered', join(work, 'tampered.drafttide'), 'BACKUP_INVALID');
const trav = [...orig, { name: 'zz/escape.txt', data: Buffer.from('x') }];
await writeZip(join(work, 'traversal.drafttide'), trav);
writeFileSync(join(work, 'traversal.drafttide'), Buffer.from(readFileSync(join(work, 'traversal.drafttide')).toString('latin1').replaceAll('zz/escape.txt', '../escape.txt'), 'latin1'));
const t2 = await tryImport('traversal', join(work, 'traversal.drafttide'), 'BACKUP_INVALID');
await writeZip(join(work, 'duplicate.drafttide'), [...orig, { name: 'manifest.json', data: Buffer.from('{}') }]);
const t3 = await tryImport('duplicate', join(work, 'duplicate.drafttide'), 'BACKUP_INVALID');
const full = readFileSync(backupFile);
writeFileSync(join(work, 'truncated.drafttide'), full.subarray(0, Math.floor(full.length / 2)));
const t4 = await tryImport('truncated', join(work, 'truncated.drafttide'), 'BACKUP_INVALID');
const busyDest = join(work, 'not-empty');
mkdirSync(busyDest, { recursive: true });
writeFileSync(join(busyDest, 'keep.txt'), 'mine\n');
const t5 = await tryImport('non-empty-destination', backupFile, 'UNTRACKED_FILES', busyDest);
check('backup.rejects', 'tampered bundle, path traversal, duplicate entry, truncated file and non-empty destination are all refused', t1 && t2 && t3 && t4 && t5 && readFileSync(join(busyDest, 'keep.txt'), 'utf8') === 'mine\n', neg);
check('backup.no-escape', 'no file was written outside the import folders', !existsSync(join(work, 'escape.txt')) && !existsSync(resolve(work, '..', 'escape.txt')));

// ---------------------------------------------------------------- report
const usage = process.resourceUsage();
results['timings'] = {
  baselineSaveMs: Math.round(base.ms),
  baselineStageMs: Math.round(base.stageMs),
  baselineRescanMs: Math.round(base.rescanMs),
  baselineWriteObjectsMs: Math.round(base.writeObjectsMs),
  avgIterationStageMs: Math.round(avg(iters.map((v) => v.stageMs))),
  avgIterationWriteObjectsMs: Math.round(avg(iters.map((v) => v.writeObjectsMs))),
  avgIterationSaveMs: Math.round(avg(iters.map((v) => v.ms))),
  p95IterationSaveMs: Math.round([...iters.map((v) => v.ms)].sort((a, b) => a - b)[Math.floor(iters.length * 0.95)] ?? 0),
  avgIterationRescanMs: Math.round(avg(iters.map((v) => v.rescanMs))),
  roundTripAllVersionsMs: Math.round(roundTripMs),
  roundTripMiB: mb(bytesVerified),
  restoreMs: Math.round(restoreMs),
  exportMs: Math.round(exportMs),
  importMs: Math.round(importMs),
  peakRssMiB: Math.round(usage.maxRSS / 1024),
  rssHighWaterMiB: rssCheckpoints,
};
results['backup'] = { fileMiB: mb(exp.bytes), bundleMiB: mb(exp.bundleBytes), snapshots: exp.manifest.snapshots.length };
results['events'] = events;
results['iterations'] = versions.map((v) => ({ i: v.i, ms: Math.round(v.ms), changedFiles: v.changedFiles, newLooseObjects: v.newLooseObjects, repoMiB: mb(v.repoAllocated), attempts: v.captureAttempts }));
results['checks'] = checks;
results['passed'] = checks.every((c) => c.pass);
const outDir = join(spikeDir, 'results');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `storage-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
console.error(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
console.error(JSON.stringify({ growth, timings: results['timings'], backup: results['backup'] }, null, 2));
console.error(`results: ${outFile}`);
if (process.env['M0_KEEP_WORK'] !== '1') rmSync(work, { recursive: true, force: true });
process.exitCode = results['passed'] ? 0 : 1;
