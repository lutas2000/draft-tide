// Builds the companion into dist/:
// - cli.mjs: the CLI and MCP server, an ESM bundle for the companion Node.
// - engine.mjs (development builds): the Engine, run on the companion Node.
// - sea/ (release builds, or --sea): the Engine as a Node SEA built from the
//   Node running this script (the same binary that ships as the companion
//   Node), with its addons beside it. Ad-hoc signed so it runs here; the
//   packaging script re-signs everything with the team's Developer ID.
// - native/ (macOS): peer-identity.node and keychain.node.
//
//   node scripts/build.ts [--sea]         development build
//   DT_BUILD_MODE=release DT_DESKTOP_APP_ID=<bundle id> DT_TEAM_ID=<team> \
//     DT_APP_VERSION=<semver> [DT_GITHUB_CLIENT_ID=<id> DT_GITHUB_APP_SLUG=<slug>] \
//     [DT_PREVIEW_RENDERER="electron/<version> chromium/<version>"] \
//     node scripts/build.ts
//
// The release requirement is the Developer ID form verified in the
// desktop-auth spike: identifier and team pinned, plus the Developer ID
// certificate markers.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_EXECUTABLE } from '@draft-tide/engine-client';
import { build, type Plugin } from 'esbuild';
import { DEV_GITHUB_APP, RELEASE_GITHUB_APP, type BuildInfo } from '../src/build-info.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function releaseRequirement(appId: string, teamId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(appId)) throw new Error(`invalid app identifier: ${appId}`);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error(`invalid team identifier: ${teamId}`);
  return [
    'anchor apple generic',
    `identifier "${appId}"`,
    `certificate leaf[subject.OU] = "${teamId}"`,
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
  ].join(' and ');
}

function buildInfo(): BuildInfo {
  const mode = process.env['DT_BUILD_MODE'] ?? 'development';
  if (mode === 'development')
    return {
      mode,
      appVersion: process.env['DT_APP_VERSION'] ?? '0.0.0-dev',
      desktopRequirement: null,
      github: { ...DEV_GITHUB_APP },
      previewRenderer: null,
    };
  if (mode !== 'release') throw new Error(`unknown DT_BUILD_MODE: ${mode}`);
  // Windows and Linux have no verified desktop identity yet (CLAUDE.md).
  if (process.platform !== 'darwin')
    throw new Error('release builds are macOS-only until desktop identity is verified elsewhere');
  const appId = process.env['DT_DESKTOP_APP_ID'];
  const teamId = process.env['DT_TEAM_ID'];
  const appVersion = process.env['DT_APP_VERSION'];
  if (!appId || !teamId || !appVersion)
    throw new Error('release builds need DT_DESKTOP_APP_ID, DT_TEAM_ID and DT_APP_VERSION');
  // The release GitHub App unless both variables name another.
  const clientId = process.env['DT_GITHUB_CLIENT_ID'] ?? null;
  const appSlug = process.env['DT_GITHUB_APP_SLUG'] ?? null;
  if ((clientId === null) !== (appSlug === null))
    throw new Error('set both DT_GITHUB_CLIENT_ID and DT_GITHUB_APP_SLUG');
  if (clientId !== null && !/^[A-Za-z0-9.]{8,64}$/.test(clientId)) throw new Error(`invalid client id: ${clientId}`);
  if (appSlug !== null && !/^[a-z0-9-]{1,100}$/.test(appSlug)) throw new Error(`invalid app slug: ${appSlug}`);
  // The packaging script names the renderer of the Preview Host it ships
  // (previewRendererId); without it the Engine has no Preview Host.
  const previewRenderer = process.env['DT_PREVIEW_RENDERER'] ?? null;
  if (previewRenderer !== null && !/^electron\/[0-9.]+ chromium\/[0-9.]+$/.test(previewRenderer))
    throw new Error(`invalid DT_PREVIEW_RENDERER: ${previewRenderer}`);
  return {
    mode,
    appVersion,
    desktopRequirement: releaseRequirement(appId, teamId),
    github: clientId !== null && appSlug !== null ? { clientId, appSlug } : { ...RELEASE_GITHUB_APP },
    previewRenderer,
  };
}

const ADDONS = [
  { name: 'peer-identity', source: 'peer-identity.c', module: 'peer_identity', libs: ['-lbsm'] },
  { name: 'keychain', source: 'keychain.c', module: 'keychain', libs: [] },
] as const;

// Built with Xcode's clang, no node-gyp: N-API symbols resolve at load time.
// Returns the addons built (none off macOS).
export function buildNative(outDir = join(root, 'dist', 'native')): string[] {
  if (process.platform !== 'darwin') return [];
  const include = [process.env['NODE_INCLUDE'], join(dirname(dirname(process.execPath)), 'include', 'node')].find(
    (d) => d !== undefined && existsSync(join(d, 'node_api.h')),
  );
  if (!include) throw new Error('node_api.h not found; set NODE_INCLUDE to a Node headers directory');
  mkdirSync(outDir, { recursive: true });
  return ADDONS.map((addon) => {
    const out = join(outDir, `${addon.name}.node`);
    execFileSync(
      '/usr/bin/xcrun',
      [
        'clang',
        '-O2',
        '-Wall',
        '-Werror',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        `-DNODE_GYP_MODULE_NAME=${addon.module}`,
        `-I${include}`,
        join(root, 'native', addon.source),
        '-framework',
        'Security',
        '-framework',
        'CoreFoundation',
        ...addon.libs,
        '-o',
        out,
      ],
      { stdio: 'inherit' },
    );
    return out;
  });
}

// The SQLite addon the Engine SEA loads, from better-sqlite3's own N-API
// prebuilds (no compile step).
function sqlitePrebuild(): string {
  const require = createRequire(join(root, 'package.json'));
  const pkg = dirname(require.resolve('better-sqlite3'));
  const file = join(pkg, '..', 'prebuilds', `${process.platform}-${process.arch}.node`);
  if (!existsSync(file)) throw new Error(`no better-sqlite3 prebuild for ${process.platform}-${process.arch}`);
  return file;
}

// Inside the SEA, better-sqlite3 is bundled, and its loader is replaced: the
// addon comes only from beside the Engine executable, like every other addon
// (src/engine/addons.ts), never from a path an option names.
const seaSqliteBinding: Plugin = {
  name: 'sea-sqlite-binding',
  setup(b) {
    b.onLoad({ filter: /better-sqlite3[\\/]lib[\\/]binding\.js$/ }, () => ({
      loader: 'js',
      contents: [
        "'use strict';",
        "const { createRequire } = require('node:module');",
        "const { dirname, join } = require('node:path');",
        'let addon;',
        'exports.getBinding = function getBinding(nativeBinding) {',
        "  if (nativeBinding != null) throw new TypeError('the Engine loads its own SQLite addon');",
        "  if (!addon) addon = createRequire(process.execPath)(join(dirname(process.execPath), 'better_sqlite3.node'));",
        '  return addon;',
        '};',
        'exports.getPrebuildPath = () => null;',
      ].join('\n'),
    }));
  },
};

// The SEA fuse postject looks for (Node's documented sentinel).
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Builds the Engine as a Node SEA in outDir (token-custody spike):
// - execArgvExtension "none": a default SEA runs code from NODE_OPTIONS.
// - execArgv --disable-sigusr1: command-line Node options are only arguments
//   to a SEA, so the Engine carries this one itself.
// - Node 24 has no --build-sea: the blob is injected with postject into a
//   copy of this Node, whose signature is removed first.
// - CommonJS: a Node 24 SEA runs one CommonJS script.
export async function buildEngineSea(info: BuildInfo, outDir: string, nativeDir: string): Promise<string> {
  const work = join(outDir, '.work');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const script = join(work, 'engine.cjs');
  await build({
    entryPoints: [join(root, 'src/engine/main.ts')],
    outfile: script,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    define: { __DT_BUILD__: JSON.stringify(info) },
    plugins: [seaSqliteBinding],
    // import.meta only appears on paths a SEA never takes (src/engine/addons.ts).
    logOverride: { 'empty-import-meta': 'silent' },
    legalComments: 'linked',
    logLevel: 'warning',
  });
  const blob = join(work, 'engine.blob');
  const config = join(work, 'sea-config.json');
  writeFileSync(
    config,
    JSON.stringify({
      main: script,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ['--disable-sigusr1'],
      execArgvExtension: 'none',
    }),
  );
  // Quiet unless it fails (it reports the blob on stderr).
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'pipe' });
  const exe = join(outDir, ENGINE_EXECUTABLE);
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--remove-signature', exe]);
  const { inject } = createRequire(join(root, 'package.json'))('postject') as {
    inject: (file: string, name: string, data: Buffer, options: Record<string, unknown>) => Promise<void>;
  };
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  copyFileSync(sqlitePrebuild(), join(outDir, 'better_sqlite3.node'));
  for (const addon of ADDONS) {
    const file = join(nativeDir, `${addon.name}.node`);
    if (existsSync(file)) copyFileSync(file, join(outDir, `${addon.name}.node`));
  }
  // Ad hoc, so it runs on this machine (arm64 runs no unsigned code); release
  // packaging signs it with the team's Developer ID under its own identifier.
  if (process.platform === 'darwin') {
    for (const file of [exe, ...['better_sqlite3', ...ADDONS.map((a) => a.name)].map((n) => join(outDir, `${n}.node`))])
      if (existsSync(file))
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  rmSync(work, { recursive: true, force: true });
  return exe;
}

async function main(): Promise<void> {
  const info = buildInfo();
  const release = info.mode === 'release';
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await build({
    // Release builds ship the Engine only as the SEA.
    entryPoints: {
      cli: join(root, 'src/cli/main.ts'),
      ...(release ? {} : { engine: join(root, 'src/engine/main.ts') }),
    },
    outdir: dist,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Native: loaded from node_modules next to the bundle (development only;
    // the CLI never loads it).
    external: ['better-sqlite3'],
    define: { __DT_BUILD__: JSON.stringify(info) },
    // Bundled CommonJS dependencies may call require().
    banner: {
      js: "import { createRequire as __dtCreateRequire } from 'node:module'; const require = __dtCreateRequire(import.meta.url);",
    },
    legalComments: 'linked',
    logLevel: 'warning',
  });
  const addons = buildNative(join(dist, 'native'));
  const sea =
    release || process.argv.includes('--sea')
      ? await buildEngineSea(info, join(dist, 'sea'), join(dist, 'native'))
      : null;
  process.stderr.write(
    `companion ${info.mode} build ${info.appVersion} → ${dist}${addons.length > 0 ? ` (+ ${addons.length} addons)` : ''}${sea ? `, Engine SEA ${sea}` : ''}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
