// Fixed at build time by scripts/build.ts (esbuild `define`). Main is always
// bundled, so there is no source-run fallback.
export interface DesktopBuildInfo {
  mode: 'development' | 'e2e' | 'release';
  appVersion: string;
  // Development only: load the GUI from the Vite dev server.
  guiDevUrl: string | null;
  // Development and e2e: the companion Node, the Engine and CLI bundles to
  // start, and the Skill folder in the repository. Release builds find them
  // inside the app's resources instead.
  companion: { nodePath: string; engineEntry: string; cliEntry: string; skillDir: string } | null;
  // e2e builds only: Playwright drives Electron through these switches. No
  // build that a user runs ever allows them.
  allowDebugSwitches: boolean;
}

declare const __DT_DESKTOP_BUILD__: DesktopBuildInfo;

export const BUILD: DesktopBuildInfo = __DT_DESKTOP_BUILD__;
