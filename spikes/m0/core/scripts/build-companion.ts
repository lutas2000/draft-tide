// Assembles the companion payload the desktop app ships as extra resources:
//   build/companion/{cli,engine}.mjs + node_modules/better-sqlite3 (prebuild only)
//   build/node/bin/node      bundled Node LTS (never the user's PATH)
//   build/git/               trimmed Git: bin/git + exec-path shim
//   build/bin/draft-tide     CLI launcher
//   build/gui/               GUI prototype build (if present)
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(core, 'build');
const platformArch = `${process.platform}-${process.arch}`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: { cli: join(core, 'src/cli.ts'), engine: join(core, 'src/engine/server.ts') },
  outdir: join(out, 'companion'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __dtRequire } from 'node:module'; const require = __dtRequire(import.meta.url);" },
  legalComments: 'external',
  metafile: true,
  logLevel: 'warning',
});

// better-sqlite3: JS loader + only this platform's N-API prebuild.
const bsSrc = join(core, 'node_modules', 'better-sqlite3');
const bsDst = join(out, 'companion', 'node_modules', 'better-sqlite3');
mkdirSync(join(bsDst, 'prebuilds'), { recursive: true });
cpSync(join(bsSrc, 'package.json'), join(bsDst, 'package.json'));
cpSync(join(bsSrc, 'LICENSE'), join(bsDst, 'LICENSE'));
cpSync(join(bsSrc, 'lib'), join(bsDst, 'lib'), { recursive: true });
cpSync(join(bsSrc, 'prebuilds', `${platformArch}.node`), join(bsDst, 'prebuilds', `${platformArch}.node`));

// Node: the exact LTS binary the spike was tested with.
const nodeHome = resolve(dirname(process.execPath), '..');
mkdirSync(join(out, 'node', 'bin'), { recursive: true });
cpSync(process.execPath, join(out, 'node', 'bin', 'node'));
chmodSync(join(out, 'node', 'bin', 'node'), 0o755);
if (existsSync(join(nodeHome, 'LICENSE'))) cpSync(join(nodeHome, 'LICENSE'), join(out, 'node', 'LICENSE'));

// Git: dugite-native's relocatable git without GCM/.NET or git-lfs.
const dugite = join(core, 'node_modules', 'dugite', 'git');
mkdirSync(join(out, 'git', 'bin'), { recursive: true });
mkdirSync(join(out, 'git', 'libexec', 'git-core'), { recursive: true });
cpSync(join(dugite, 'bin', 'git'), join(out, 'git', 'bin', 'git'));
symlinkSync('../../bin/git', join(out, 'git', 'libexec', 'git-core', 'git'));
writeFileSync(join(out, 'git', 'SOURCE.txt'), 'Git 2.53.0 from desktop/dugite-native v2.53.0-4 (macOS arm64). GPL-2.0: ship COPYING + source offer before any release.\n');

// CLI launcher: always the bundled Node, never PATH.
mkdirSync(join(out, 'bin'), { recursive: true });
writeFileSync(
  join(out, 'bin', 'draft-tide'),
  `#!/bin/sh
# Draft Tide CLI launcher (M0 spike)
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
res="$(cd "$(dirname "$self")/.." && pwd)"
exec "$res/node/bin/node" "$res/companion/cli.mjs" "$@"
`,
);
chmodSync(join(out, 'bin', 'draft-tide'), 0o755);

const gui = resolve(core, '..', 'gui', 'dist');
if (existsSync(gui)) cpSync(gui, join(out, 'gui'), { recursive: true });

function du(p: string): number {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size;
  return readdirSync(p).reduce((a, n) => a + du(join(p, n)), 0);
}
const sizes = Object.fromEntries(['companion', 'node', 'git', 'bin', 'gui'].filter((d) => existsSync(join(out, d))).map((d) => [d, `${(du(join(out, d)) / 1024 / 1024).toFixed(1)} MiB`]));
const bundles = Object.fromEntries(Object.entries(result.metafile.outputs).filter(([k]) => k.endsWith('.mjs')).map(([k, v]) => [k.split('/').pop(), `${(v.bytes / 1024).toFixed(0)} KiB`]));
console.log(JSON.stringify({ platformArch, node: process.version, sizes, bundles, nodeBytes: statSync(join(out, 'node', 'bin', 'node')).size }, null, 2));
