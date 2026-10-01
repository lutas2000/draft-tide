// Fixed at build time by scripts/build.ts (esbuild `define`). Main is always
// bundled, so there is no source-run fallback.
export interface DesktopBuildInfo {
  mode: 'development' | 'e2e' | 'release';
  appVersion: string;
  // Development only: load the GUI from the Vite dev server.
  guiDevUrl: string | null;
  // Development and e2e: the companion Node and Engine bundle to start.
  // Release builds find both inside the app's resources instead.
  companion: { nodePath: string; engineEntry: string } | null;
  // e2e builds only: Playwright drives Electron through these switches. No
  // build that a user runs ever allows them.
  allowDebugSwitches: boolean;
}

declare const __DT_DESKTOP_BUILD__: DesktopBuildInfo;

export const BUILD: DesktopBuildInfo = __DT_DESKTOP_BUILD__;
