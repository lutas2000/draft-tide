// Builds the desktop app: Main (ESM) and the sandboxed preload (CJS) with
// esbuild, the GUI with Vite.
//
//   node scripts/build.ts          development build → dist/
//   node scripts/build.ts --e2e    Playwright build → dist-e2e/
//
// Development and e2e builds start the companion from apps/companion/dist with
// the Node that runs this script. Release builds (dist-release/) find the
// companion, the Engine, Git and the Skill in the app's resources; only the
// packaging script (scripts/package.ts) makes them.
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import type { DesktopBuildInfo } from '../src/main/build-info.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const companionEngine = join(root, '..', 'companion', 'dist', 'engine.mjs');
const companionCli = join(root, '..', 'companion', 'dist', 'cli.mjs');
const skillDir = join(root, '..', '..', 'skills', 'draft-tide');

export interface DesktopBuildOptions {
  mode: 'development' | 'e2e' | 'release';
  guiDevUrl?: string;
  skipGui?: boolean;
  appVersion?: string;
}

const OUT_DIRS = { development: 'dist', e2e: 'dist-e2e', release: 'dist-release' } as const;

export async function buildDesktop(options: DesktopBuildOptions): Promise<string> {
  const release = options.mode === 'release';
  if (!release && !existsSync(companionEngine)) {
    throw new Error(`companion is not built (${companionEngine}); run: pnpm --filter @draft-tide/companion build`);
  }
  const outDir = join(root, OUT_DIRS[options.mode]);
  const info: DesktopBuildInfo = {
    mode: options.mode,
    appVersion: options.appVersion ?? process.env['DT_APP_VERSION'] ?? '0.0.0-dev',
    guiDevUrl: release ? null : (options.guiDevUrl ?? null),
    companion: release
      ? null
      : { nodePath: process.execPath, engineEntry: companionEngine, cliEntry: companionCli, skillDir },
    allowDebugSwitches: options.mode === 'e2e',
  };
  for (const part of ['main', 'preload']) rmSync(join(outDir, part), { recursive: true, force: true });
  const common = {
    bundle: true,
    platform: 'node' as const,
    target: 'node24',
    external: ['electron'],
    define: { __DT_DESKTOP_BUILD__: JSON.stringify(info) },
    logLevel: 'warning' as const,
    sourcemap: !release,
  };
  await esbuild({
    ...common,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(outDir, 'main', 'main.mjs'),
    format: 'esm',
    banner: {
      js: "import { createRequire as __dtCreateRequire } from 'node:module'; const require = __dtCreateRequire(import.meta.url);",
    },
  });
  await esbuild({
    ...common,
    entryPoints: [join(root, 'src/preload/preload.ts')],
    outfile: join(outDir, 'preload', 'preload.cjs'),
    format: 'cjs',
  });
  if (!options.skipGui) {
    await viteBuild({
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'warn',
      build: { outDir: join(outDir, 'gui'), emptyOutDir: true, sourcemap: !release },
    });
  }
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--release')) {
    throw new Error('release builds are made by the packaging script: node scripts/package.ts');
  }
  const mode = process.argv.includes('--e2e') ? 'e2e' : 'development';
  const out = await buildDesktop({ mode });
  process.stderr.write(`desktop ${mode} build → ${out}\n`);
}
