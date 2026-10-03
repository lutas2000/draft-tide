// What a release build is made with: the signing identity, the identifiers
// every signed part gets, and the pinned inputs. Read from the environment of
// the packaging script only; nothing here reaches a running app except what
// the builds compile in (the desktop requirement, the app version, the GitHub
// App).
//
//   DT_APP_VERSION      the version (semver), required
//   DT_TEAM_ID          the Developer ID team, required
//   DT_SIGN_IDENTITY    the "Developer ID Application: …" certificate (name or
//                       SHA-1) in the login keychain, required
//   DT_DESKTOP_APP_ID   the desktop app's bundle identifier (default below)
//   DT_NOTARY_PROFILE   a `notarytool store-credentials` profile; without it
//                       the build is signed but not notarized
//   DT_GITHUB_CLIENT_ID, DT_GITHUB_APP_SLUG
//                       another GitHub App than the release one (the
//                       companion's RELEASE_GITHUB_APP)
//
// The identifiers are part of the security model (CLAUDE.md "Desktop
// identity"): the desktop app, the Engine, the companion Node and the Preview
// Host each have their own, under one team. The Engine's identifier is also what its
// keychain item trusts, so changing it loses every signed-in user's token;
// the app's is compiled into the Engine as the desktop requirement.
import { RELEASE_GITHUB_APP } from '../../../companion/src/build-info.ts';

export const DEFAULT_APP_ID = 'app.drafttide.desktop';

export interface ReleaseIdentifiers {
  app: string;
  // The Preview Host executable: the app's executable under another
  // identifier, so the desktop requirement never admits it.
  previewHost: string;
  engine: string;
  node: string;
  git: string;
  gitRemoteHttps: string;
  // Prefix of the Engine's native addons (`<prefix>.<addon>`).
  addon: string;
  dmg: string;
}

export interface ReleaseConfig {
  appVersion: string;
  teamId: string;
  identity: string;
  ids: ReleaseIdentifiers;
  notaryProfile: string | null;
  github: { clientId: string; appSlug: string };
}

export function identifiers(appId: string): ReleaseIdentifiers {
  return {
    app: appId,
    previewHost: `${appId}.preview-host`,
    engine: `${appId}.engine`,
    node: `${appId}.companion-node`,
    git: `${appId}.git`,
    gitRemoteHttps: `${appId}.git-remote-https`,
    addon: `${appId}.engine`,
    dmg: `${appId}.dmg`,
  };
}

export function readReleaseConfig(env: NodeJS.ProcessEnv = process.env): ReleaseConfig {
  const missing = ['DT_APP_VERSION', 'DT_TEAM_ID', 'DT_SIGN_IDENTITY'].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`a release build needs ${missing.join(', ')}`);
  const appVersion = env['DT_APP_VERSION'] ?? '';
  const teamId = env['DT_TEAM_ID'] ?? '';
  const identity = env['DT_SIGN_IDENTITY'] ?? '';
  const appId = env['DT_DESKTOP_APP_ID'] ?? DEFAULT_APP_ID;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(appVersion)) throw new Error(`invalid DT_APP_VERSION: ${appVersion}`);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error(`invalid DT_TEAM_ID: ${teamId}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/.test(appId)) throw new Error(`invalid DT_DESKTOP_APP_ID: ${appId}`);
  // A Developer ID Application certificate of this team, or its SHA-1. An
  // Apple Development or Distribution certificate would pass the anchor but
  // not the Developer ID markers the Engine requires.
  const byName = identity.startsWith('Developer ID Application: ') && identity.endsWith(`(${teamId})`);
  if (!byName && !/^[0-9A-F]{40}$/.test(identity))
    throw new Error(`DT_SIGN_IDENTITY must be "Developer ID Application: … (${teamId})" or a SHA-1`);
  const clientId = env['DT_GITHUB_CLIENT_ID'] ?? null;
  const appSlug = env['DT_GITHUB_APP_SLUG'] ?? null;
  if ((clientId === null) !== (appSlug === null))
    throw new Error('set both DT_GITHUB_CLIENT_ID and DT_GITHUB_APP_SLUG');
  return {
    appVersion,
    teamId,
    identity,
    ids: identifiers(appId),
    notaryProfile: env['DT_NOTARY_PROFILE'] || null,
    github: clientId !== null && appSlug !== null ? { clientId, appSlug } : { ...RELEASE_GITHUB_APP },
  };
}
