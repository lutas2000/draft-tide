// Opening the app for a request (M1 plan §5, §9.1): when the tool channel
// asks for something only the user does in the app, an open app comes forward
// (core publishes request.waiting) and a closed one is started. The Engine
// starts only the app of its own installation, found from its own place
// (packagedLayout), never one named by the environment, an argument or the
// database; a development Engine starts what its launcher named. Starting the
// app decides nothing: the request waits there for the user.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isSea } from 'node:sea';
import { APP_LAUNCH_ENV, AppLaunch, type AppAttention } from '@draft-tide/contracts';
import type { DesktopApp } from '@draft-tide/core';
import { DATA_DIR_ENV, defaultDataDir, engineEnvironment, packagedLayout } from '@draft-tide/engine-client';
import type { BuildInfo } from '../build-info.ts';

// After starting the app, further requests within this long say it is
// opening rather than start it again.
export const OPENING_MS = 30_000;

// How this Engine opens the app.
// - Release (macOS): the app bundle it ships in, with `open -n -a`. -n starts
//   an instance even if one runs: an app on another data store is another
//   instance, and one already on this data store hands over to the running
//   one (Electron's single-instance lock, kept per data store) and quits.
// - Development: the launcher's {command, args} (APP_LAUNCH_ENV).
// null: this Engine can't open the app (no app here, another platform).
export type AppStarter = { kind: 'bundle'; bundle: string } | { kind: 'command'; launch: AppLaunch };

export function desktopAppStarter(
  build: BuildInfo,
  env = process.env,
  engine = { sea: isSea(), execPath: process.execPath, platform: process.platform },
): AppStarter | null {
  if (build.mode === 'release') {
    if (!engine.sea || engine.platform !== 'darwin') return null;
    const bundle = packagedLayout(dirname(dirname(engine.execPath)), 'darwin').app;
    if (!bundle.endsWith('.app') || !existsSync(join(bundle, 'Contents', 'Info.plist'))) return null;
    return { kind: 'bundle', bundle };
  }
  const raw = env[APP_LAUNCH_ENV];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const launch = AppLaunch.safeParse(parsed);
  return launch.success && isAbsolute(launch.data.command) ? { kind: 'command', launch: launch.data } : null;
}

// The command line and environment of one start, for this data directory.
// The environment is built from scratch (the OS basics and the data
// directory); `open` hands its own to the app only through --env, so a data
// directory other than the default goes that way.
export function appStart(
  starter: AppStarter,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; env: Record<string, string> } {
  const env = engineEnvironment(dataDir, {}, platform);
  if (starter.kind === 'command') return { command: starter.launch.command, args: starter.launch.args, env };
  const custom = dataDir !== defaultDataDir(platform, env);
  return {
    command: '/usr/bin/open',
    args: ['-n', '-a', starter.bundle, ...(custom ? ['--env', `${DATA_DIR_ENV}=${dataDir}`] : [])],
    env,
  };
}

export function createDesktopApp(options: {
  starter: AppStarter | null;
  dataDir: string;
  // Verified desktop sessions now: the app is open on this data store.
  desktopSessions: () => number;
  log: (msg: string) => void;
  now?: () => number;
}): DesktopApp {
  const now = options.now ?? Date.now;
  let startedAt: number | null = null;
  return {
    attend(): AppAttention {
      if (options.desktopSessions() > 0) return 'shown';
      if (startedAt !== null && now() - startedAt < OPENING_MS) return 'opening';
      if (!options.starter) return 'unavailable';
      const start = appStart(options.starter, options.dataDir);
      try {
        const child = spawn(start.command, start.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          env: start.env,
        });
        child.on('error', (e) => options.log(`could not open the app for a request: ${e.message}`));
        child.on('exit', (code) => {
          if (code !== 0 && code !== null) options.log(`opening the app for a request exited with ${code}`);
        });
        child.unref();
      } catch (e) {
        options.log(`could not open the app for a request: ${e instanceof Error ? e.message : String(e)}`);
        return 'unavailable';
      }
      startedAt = now();
      options.log('opening the app for a request');
      return 'opening';
    },
  };
}
