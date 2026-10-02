import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteProvider } from '@draft-tide/core';
import {
  GITHUB_ENDPOINTS,
  TEST_GITHUB_ENV,
  createGitHubProvider,
  createMemoryVault,
  parseTestEndpoints,
  type GitHubEndpoints,
  type TokenVault,
} from '@draft-tide/remote-github';
import type { BuildInfo } from '../build-info.ts';

// GitHub for the Engine (CLAUDE.md "GitHub sign-in", "Token custody"). The
// grant lives in one login-keychain item per data store, created by the
// Engine in-process through its addon, so the item's access list trusts only
// the Engine's own signature. Reads never show a dialog.
//
// Development builds: on macOS the same keychain item, which then trusts the
// development Node (any script on that Node could read it; the SEA closes
// this in release builds, M1-09). Elsewhere, and with the test GitHub
// (DRAFT_TIDE_TEST_GITHUB, loopback only), an in-memory vault: the sign-in
// lasts as long as the Engine. Release builds ignore the test GitHub and have
// no vault outside macOS (sign-in unavailable, no-keychain).

interface KeychainAddon {
  read(service: string, account: string): { status: number; message: string; data?: Buffer };
  write(service: string, account: string, label: string, data: Buffer): { status: number; message: string };
  remove(service: string, account: string): { status: number; message: string };
}

const ERR_ITEM_NOT_FOUND = -25300;
// The item exists but this program isn't on its access list (an older
// development Node made it). Anything else (a locked keychain:
// errSecInteractionNotAllowed) must never cost the user their sign-in.
const NOT_TRUSTED = new Set([-25293, -25243, -25244]);
const ADDON_FILE = 'keychain.node';

// Next to the bundled engine.mjs (dist/native), or the dev build when running
// from source. Never a path from the environment, arguments or settings.
function loadAddon(): KeychainAddon | null {
  if (process.platform !== 'darwin') return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const file = [join(here, 'native', ADDON_FILE), join(here, '..', '..', 'dist', 'native', ADDON_FILE)].find((c) =>
    existsSync(c),
  );
  if (!file) return null;
  return createRequire(import.meta.url)(file) as KeychainAddon;
}

export function createKeychainVault(
  addon: KeychainAddon,
  item: { service: string; account: string; label: string },
): TokenVault {
  const fail = (what: string, r: { status: number; message: string }) =>
    new Error(`keychain ${what} failed (${r.status}): ${r.message}`);
  return {
    kind: 'keychain',
    read() {
      const r = addon.read(item.service, item.account);
      if (r.status === ERR_ITEM_NOT_FOUND) return Promise.resolve(null);
      if (r.status !== 0 || !r.data) return Promise.reject(fail('read', r));
      return Promise.resolve(new Uint8Array(r.data));
    },
    write(bytes) {
      let r = addon.write(item.service, item.account, item.label, Buffer.from(bytes));
      if (NOT_TRUSTED.has(r.status)) {
        // An item this program isn't trusted for: replace it.
        addon.remove(item.service, item.account);
        r = addon.write(item.service, item.account, item.label, Buffer.from(bytes));
      }
      return r.status === 0 ? Promise.resolve() : Promise.reject(fail('write', r));
    },
    clear() {
      const r = addon.remove(item.service, item.account);
      return r.status === 0 || r.status === ERR_ITEM_NOT_FOUND ? Promise.resolve() : Promise.reject(fail('remove', r));
    },
  };
}

export function createEngineGitHub(options: {
  build: BuildInfo;
  storeId: string;
  log: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
}): RemoteProvider {
  const { build, storeId, log } = options;
  const env = options.env ?? process.env;
  let endpoints: GitHubEndpoints = GITHUB_ENDPOINTS;
  const test = build.mode === 'development' ? env[TEST_GITHUB_ENV] : undefined;
  if (test) {
    endpoints = parseTestEndpoints(test);
    log(`test GitHub at ${endpoints.web} (development build)`);
  }
  let vault: TokenVault | null = null;
  if (test) vault = createMemoryVault();
  else {
    let addon: KeychainAddon | null = null;
    try {
      addon = loadAddon();
    } catch (e) {
      log(`keychain addon unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (addon) {
      const development = build.mode === 'development';
      vault = createKeychainVault(addon, {
        service: development ? 'dev.drafttide.github' : 'app.drafttide.github',
        account: storeId,
        label: development ? 'Draft Tide GitHub sign-in (development)' : 'Draft Tide GitHub sign-in',
      });
    } else if (build.mode === 'development') {
      vault = createMemoryVault();
      log('no keychain here: the GitHub sign-in lasts as long as this Engine (development build)');
    } else log('no keychain here: GitHub sign-in is unavailable');
  }
  return createGitHubProvider({
    clientId: build.github.clientId,
    appSlug: build.github.appSlug,
    endpoints,
    vault,
    userAgent: `DraftTide/${build.appVersion}`,
    log,
  });
}
