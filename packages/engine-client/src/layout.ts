import { posix, win32 } from 'node:path';

// Where a packaged release keeps its parts, inside the app's resources
// (Contents/Resources on macOS). The packaging script assembles exactly this
// layout; the desktop app, the CLI and the Engine find each other through it.
// Nothing here comes from the environment, arguments or settings.
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
}

export const ENGINE_EXECUTABLE = 'draft-tide-engine';

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
  };
}
