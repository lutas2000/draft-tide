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
  // Release builds: the renderer of the Preview Host packaged with this
  // Engine (previewRendererId of its Electron and Chromium), which previews
  // are cached under; null: no Preview Host. Development builds take the
  // host, renderer included, from their launcher (DRAFT_TIDE_PREVIEW_HOST).
  previewRenderer: string | null;
}

// The development GitHub App (installable on its owner's account only).
export const DEV_GITHUB_APP = { clientId: 'Iv23lisc6TyzrEU07Wt4', appSlug: 'draft-tide-dev-lutas2000' } as const;

// The release GitHub App (public, installable on any account; created
// 2026-10-03). Release builds compile it in unless DT_GITHUB_CLIENT_ID and
// DT_GITHUB_APP_SLUG name another. The client ID is public; there is no client
// secret or private key anywhere.
export const RELEASE_GITHUB_APP = { clientId: 'Iv23li5bVjuyY8pVqtz5', appSlug: 'draft-tide' } as const;

declare const __DT_BUILD__: BuildInfo | undefined;

export const BUILD: BuildInfo =
  typeof __DT_BUILD__ !== 'undefined'
    ? __DT_BUILD__
    : {
        mode: 'development',
        appVersion: '0.0.0-dev',
        desktopRequirement: null,
        github: { ...DEV_GITHUB_APP },
        previewRenderer: null,
      };
