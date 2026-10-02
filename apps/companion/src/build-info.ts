// Facts fixed when the companion is built (scripts/build.ts injects them with
// esbuild `define`). Running from source means a development build.
//
// The desktop code-signing requirement lives only here. Nothing at runtime
// (environment, arguments, files) can set or relax it: otherwise any process
// could start the real Engine with a weaker check and claim to be the desktop.
export interface BuildInfo {
  mode: 'development' | 'release';
  appVersion: string;
  // Release builds: the requirement the desktop app's signature must satisfy.
  // Development builds: null (no signature check; instance pinning still runs
  // where the platform supports it).
  desktopRequirement: string | null;
  // The GitHub App sign-in uses (M1 plan §10.1): its public client ID and
  // URL name. Both null: this build can't sign in.
  github: { clientId: string | null; appSlug: string | null };
}

// The development GitHub App (installable on its owner's account only). The
// release app is created before M1-09 and passed to release builds.
export const DEV_GITHUB_APP = { clientId: 'Iv23lisc6TyzrEU07Wt4', appSlug: 'draft-tide-dev-lutas2000' } as const;

declare const __DT_BUILD__: BuildInfo | undefined;

export const BUILD: BuildInfo =
  typeof __DT_BUILD__ !== 'undefined'
    ? __DT_BUILD__
    : { mode: 'development', appVersion: '0.0.0-dev', desktopRequirement: null, github: { ...DEV_GITHUB_APP } };
