import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineLaunch } from '@draft-tide/engine-client';
import { BUILD } from './build-info.ts';

// The CLI and MCP server run on the bundled companion Node, so the Engine is
// started with this same executable. The entry sits next to the bundle
// (dist/engine.mjs), or is the source file in development.
export function engineLaunch(): EngineLaunch {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'engine.mjs'), join(here, 'engine', 'main.ts')];
  const engineEntry = candidates.find((c) => existsSync(c));
  if (!engineEntry) throw new Error(`Engine entry not found next to ${here}`);
  const env: Record<string, string> = {};
  const idle = process.env['DRAFT_TIDE_ENGINE_IDLE_MS'];
  if (idle) env['DRAFT_TIDE_ENGINE_IDLE_MS'] = idle;
  // Development builds may run another Git; release builds only the bundled one.
  const git = process.env['DRAFT_TIDE_GIT'];
  if (git && BUILD.mode === 'development') env['DRAFT_TIDE_GIT'] = git;
  return { nodePath: process.execPath, engineEntry, env };
}
