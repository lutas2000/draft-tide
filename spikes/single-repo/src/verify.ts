import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitVersionOf } from './harness-info.ts';
import { resolveGitRuntime } from './git.ts';
import { Ext, Suite, makeWork } from './harness.ts';
import { runLocalTests, type Ctx } from './tests-local.ts';
import { runHostileTests } from './tests-hostile.ts';
import { runSyncTests } from './tests-sync.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const want = (k: string) => only.length === 0 || only.includes(k);

const w = makeWork();
const rt = resolveGitRuntime(w.gitHome);
const ext = new Ext(w);
const s = new Suite();
const ctx: Ctx = { w, ext, rt, s };

console.log(`single-repo spike  work=${w.dir}`);
console.log(`bundled git: ${await gitVersionOf(rt)}  (${rt.source})`);
console.log(`external git: ${ext.git(w.dir, ['--version']).trim()}`);

if (want('local')) await runLocalTests(ctx);
if (want('hostile')) await runHostileTests(ctx);
if (want('sync')) await runSyncTests(ctx);

const failed = s.results.filter((r) => !r.ok);
console.log(`\n${s.results.length - failed.length}/${s.results.length} checks passed`);
const out = join(HERE, '..', 'results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `verify-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ git: await gitVersionOf(rt), results: s.results, observations: s.observations }, null, 2));
if (!process.env['SPIKE_KEEP_WORK']) rmSync(w.dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
