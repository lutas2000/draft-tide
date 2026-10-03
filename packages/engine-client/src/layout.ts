import { posix, win32 } from 'node:path';

// Where a packaged release keeps its parts, inside the app's resources
// (Contents/Resources on macOS), plus the Preview Host beside the app's own
// executable. The packaging script assembles exactly this layout; the desktop
// app, the CLI and the Engine find each other through it. Nothing here comes
// from the environment, arguments or settings.
export interface PackagedLayout {
  // The companion Node: runs the CLI and the MCP server, never the Engine.
  node: string;
  cli: string;
  // The Engine: a Node SEA with its own signing identifier, its native addons
  // beside it.
  engine: string;
  engineDir: string;
  // The bundled Git and the exec path it needs (it can't derive its own).
  git: string;
  gitExecPath: string;
  skillDir: string;
  // The Preview Host: a copy of the app's executable with its own signing
  // identifier (outside the desktop requirement), in Contents/MacOS. It sits
  // there because Electron finds its framework, helpers and app.asar from
  // the executable's bundle, and checks the asar's integrity only inside it.
  previewHost: string;
  // The desktop app itself: its bundle on macOS (what `open` launches), its
  // executable elsewhere. The Engine opens it for a request (M1 plan §5).
  app: string;
}

export const ENGINE_EXECUTABLE = 'draft-tide-engine';
export const PREVIEW_HOST_EXECUTABLE = 'Draft Tide Preview';
export const APP_EXECUTABLE = 'Draft Tide';

export function packagedLayout(resources: string, platform: NodeJS.Platform = process.platform): PackagedLayout {
  const path = platform === 'win32' ? win32 : posix;
  const exe = (name: string) => (platform === 'win32' ? `${name}.exe` : name);
  const engineDir = path.join(resources, 'engine');
  return {
    node: path.join(resources, 'node', 'bin', exe('node')),
    cli: path.join(resources, 'companion', 'cli.mjs'),
    engine: path.join(engineDir, exe(ENGINE_EXECUTABLE)),
    engineDir,
    git: path.join(resources, 'git', 'bin', exe('git')),
    gitExecPath: path.join(resources, 'git', 'libexec', 'git-core'),
    skillDir: path.join(resources, 'skills', 'draft-tide'),
    previewHost:
      platform === 'darwin'
        ? path.join(resources, '..', 'MacOS', PREVIEW_HOST_EXECUTABLE)
        : path.join(resources, '..', exe(PREVIEW_HOST_EXECUTABLE)),
    app: platform === 'darwin' ? path.join(resources, '..', '..') : path.join(resources, '..', exe(APP_EXECUTABLE)),
  };
}
