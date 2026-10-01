// Builds the companion into dist/: engine.mjs and cli.mjs (esbuild bundles for
// the bundled Node) and, on macOS, native/peer-identity.node.
//
//   node scripts/build.ts                 development build
//   DT_BUILD_MODE=release DT_DESKTOP_APP_ID=<bundle id> DT_TEAM_ID=<team> \
//     DT_APP_VERSION=<semver> node scripts/build.ts
//
// The release requirement is the Developer ID form verified in the
// desktop-auth spike: identifier and team pinned, plus the Developer ID
// certificate markers.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { BuildInfo } from '../src/build-info.ts';

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
    return { mode, appVersion: process.env['DT_APP_VERSION'] ?? '0.0.0-dev', desktopRequirement: null };
  if (mode !== 'release') throw new Error(`unknown DT_BUILD_MODE: ${mode}`);
  // Windows and Linux have no verified desktop identity yet (CLAUDE.md).
  if (process.platform !== 'darwin')
    throw new Error('release builds are macOS-only until desktop identity is verified elsewhere');
  const appId = process.env['DT_DESKTOP_APP_ID'];
  const teamId = process.env['DT_TEAM_ID'];
  const appVersion = process.env['DT_APP_VERSION'];
  if (!appId || !teamId || !appVersion)
    throw new Error('release builds need DT_DESKTOP_APP_ID, DT_TEAM_ID and DT_APP_VERSION');
  return { mode, appVersion, desktopRequirement: releaseRequirement(appId, teamId) };
}

// Built with Xcode's clang, no node-gyp: N-API symbols resolve at load time.
export function buildNative(outDir = join(root, 'dist', 'native')): string | null {
  if (process.platform !== 'darwin') return null;
  const include = [process.env['NODE_INCLUDE'], join(dirname(dirname(process.execPath)), 'include', 'node')].find(
    (d) => d !== undefined && existsSync(join(d, 'node_api.h')),
  );
  if (!include) throw new Error('node_api.h not found; set NODE_INCLUDE to a Node headers directory');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'peer-identity.node');
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
      '-DNODE_GYP_MODULE_NAME=peer_identity',
      `-I${include}`,
      join(root, 'native', 'peer-identity.c'),
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
      '-lbsm',
      '-o',
      out,
    ],
    { stdio: 'inherit' },
  );
  return out;
}

async function main(): Promise<void> {
  const info = buildInfo();
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await build({
    entryPoints: { engine: join(root, 'src/engine/main.ts'), cli: join(root, 'src/cli/main.ts') },
    outdir: dist,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Native: loaded from node_modules next to the bundle (packaging copies it).
    external: ['better-sqlite3'],
    define: { __DT_BUILD__: JSON.stringify(info) },
    // Bundled CommonJS dependencies may call require().
    banner: {
      js: "import { createRequire as __dtCreateRequire } from 'node:module'; const require = __dtCreateRequire(import.meta.url);",
    },
    legalComments: 'linked',
    logLevel: 'warning',
  });
  const addon = buildNative(join(dist, 'native'));
  process.stderr.write(
    `companion ${info.mode} build ${info.appVersion} → ${dist}${addon ? ' (+ peer-identity addon)' : ''}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
