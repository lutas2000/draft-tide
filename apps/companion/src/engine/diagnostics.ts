// What 設定與診斷 needs from this Engine process (M1 plan §4.1): the data
// directory's use by part and its free space, the end of the Engine's log,
// the OS release and Git's version, and the values a report must never quote
// (core adds the projects' folders and names and the GitHub accounts).
import { open, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, hostname, release, tmpdir, userInfo } from 'node:os';
import { measureTree, volumeSpace } from '@draft-tide/adapter-filesystem';
import type { DataStorePart } from '@draft-tide/contracts';
import type { DiagnosticsHost } from '@draft-tide/core';
import { DESKTOP_PROFILE_DIR } from '@draft-tide/engine-client';
import { gitVersion, type GitRuntime } from '@draft-tide/git-backend';
import { STATE_DB_FILE } from '@draft-tide/local-store';

export const LOG_DIR = 'diagnostics';

// Where each path of the data directory belongs (its segments relative to
// it). The layout: state.sqlite (and its WAL), projects/<id>/operations
// (staging), projects/<id>/cache (previews), diagnostics/ (the log),
// desktop/ (the app's Chromium profile), and the rest.
export function dataStorePart(segments: readonly string[]): DataStorePart {
  const [top, , sub] = segments;
  if (segments.length === 1 && top?.startsWith(STATE_DB_FILE)) return 'database';
  if (top === 'projects' && sub === 'operations') return 'staging';
  if (top === 'projects' && sub === 'cache') return 'previews';
  if (top === LOG_DIR) return 'logs';
  if (top === DESKTOP_PROFILE_DIR) return 'desktop';
  return 'other';
}

// The last maxBytes of the file, from the first whole line in them.
export async function tailOf(file: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { text: '', truncated: false };
  }
  const start = Math.max(0, size - maxBytes);
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

// A path and the form the filesystem resolves it to (macOS: /var is
// /private/var), both private.
function withReal(path: string): string[] {
  try {
    const real = realpathSync.native(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

export function createDiagnosticsHost(options: {
  dataDir: string;
  logFile: string;
  git: GitRuntime | null;
}): DiagnosticsHost {
  const { dataDir, logFile, git } = options;
  return {
    async dataStoreUsage() {
      const measured = await measureTree(dataDir, dataStorePart);
      return {
        parts: {
          database: measured.bytes.get('database') ?? 0,
          staging: measured.bytes.get('staging') ?? 0,
          previews: measured.bytes.get('previews') ?? 0,
          logs: measured.bytes.get('logs') ?? 0,
          desktop: measured.bytes.get('desktop') ?? 0,
          other: measured.bytes.get('other') ?? 0,
        },
        complete: measured.complete,
      };
    },
    dataStoreSpace: () => volumeSpace(dataDir),
    logTail: (maxBytes) => tailOf(logFile, maxBytes),
    async environment() {
      return { osRelease: release(), git: git ? await gitVersion(git) : null };
    },
    privateValues() {
      const paths = [dataDir, homedir(), tmpdir()].flatMap(withReal);
      const words: string[] = [];
      try {
        words.push(userInfo().username);
      } catch {
        // No user database entry.
      }
      const host = hostname();
      words.push(host, host.split('.')[0] ?? host);
      return { paths: [...new Set(paths)], words: [...new Set(words.filter((w) => w.length > 0))] };
    },
  };
}
