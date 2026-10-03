import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_HOST_ENV, TEST_GITHUB_ENV } from '@draft-tide/contracts';
import { packagedLayout, scriptEngineLaunch, type EngineLaunch } from '@draft-tide/engine-client';
import { BUILD } from './build-info.ts';

// How the CLI and MCP server start the Engine.
// - Release builds: the Engine executable of the same app (a Node SEA with its
//   own signing identity). This bundle sits at <resources>/companion/cli.mjs.
// - Development builds: the Engine script on this same companion Node, next to
//   the bundle (dist/engine.mjs) or the source file.
export function engineLaunch(): EngineLaunch {
  const here = dirname(fileURLToPath(import.meta.url));
  const env: Record<string, string> = {};
  const idle = process.env['DRAFT_TIDE_ENGINE_IDLE_MS'];
  if (idle) env['DRAFT_TIDE_ENGINE_IDLE_MS'] = idle;
  if (BUILD.mode === 'release') {
    return { command: packagedLayout(dirname(here)).engine, args: [], env };
  }
  const candidates = [join(here, 'engine.mjs'), join(here, 'engine', 'main.ts')];
  const engineEntry = candidates.find((c) => existsSync(c));
  if (!engineEntry) throw new Error(`Engine entry not found next to ${here}`);
  // Development builds may run another Git; release builds only the bundled one.
  const git = process.env['DRAFT_TIDE_GIT'];
  if (git) env['DRAFT_TIDE_GIT'] = git;
  // So may their Engine's Preview Host (the desktop app passes its own).
  const previewHost = process.env[PREVIEW_HOST_ENV];
  if (previewHost) env[PREVIEW_HOST_ENV] = previewHost;
  // And the test GitHub (tests, the desktop E2E).
  const testGitHub = process.env[TEST_GITHUB_ENV];
  if (testGitHub) env[TEST_GITHUB_ENV] = testGitHub;
  return scriptEngineLaunch(process.execPath, engineEntry, env);
}
