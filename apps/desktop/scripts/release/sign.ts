// Developer ID signing of the whole app, inside out (@electron/osx-sign walks
// every Mach-O, framework and helper app and signs the bundle last).
//
// Every Mach-O gets the team's Developer ID, hardened runtime and a secure
// timestamp. No file gets get-task-allow, dyld environment variables or a
// library-validation exemption (CLAUDE.md "Hardening"), so library validation
// admits only the team's code and the system's. Entitlements:
// - JIT only: the app, its Preview Host and its helpers (V8), the companion
//   Node and the Engine (a SEA crashes at start without it).
// - Nothing: Git, the Engine's addons, frameworks and libraries.
//
// Identifiers: the payload's own (config.ts), never the app's; bundles keep the
// identifier of their Info.plist (the app, its helpers, Electron's frameworks).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { sign } from '@electron/osx-sign';
import { ENGINE_EXECUTABLE, PREVIEW_HOST_EXECUTABLE } from '@draft-tide/engine-client';
import type { ReleaseIdentifiers } from './config.ts';

function entitlementsFile(dir: string, name: string, keys: string[]): string {
  const file = join(dir, `${name}.plist`);
  const body = keys.map((k) => `    <key>${k}</key>\n    <true/>`).join('\n');
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n${body}\n  </dict>\n</plist>\n`,
  );
  return file;
}

export const JIT_ENTITLEMENT = 'com.apple.security.cs.allow-jit';
export const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.get-task-allow',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-library-validation',
] as const;

export interface PayloadFile {
  identifier: string;
  jit: boolean;
}

// The Mach-Os Draft Tide adds to Electron's bundle, by path inside Contents
// (packagedLayout): the Preview Host beside the app's executable, and the
// payload in Resources.
export function payloadSigning(ids: ReleaseIdentifiers): Map<string, PayloadFile> {
  const resources = (...parts: string[]) => join('Resources', ...parts);
  return new Map<string, PayloadFile>([
    [join('MacOS', PREVIEW_HOST_EXECUTABLE), { identifier: ids.previewHost, jit: true }],
    [resources('node', 'bin', 'node'), { identifier: ids.node, jit: true }],
    [resources('engine', ENGINE_EXECUTABLE), { identifier: ids.engine, jit: true }],
    [resources('engine', 'better_sqlite3.node'), { identifier: `${ids.addon}.better-sqlite3`, jit: false }],
    [resources('engine', 'peer-identity.node'), { identifier: `${ids.addon}.peer-identity`, jit: false }],
    [resources('engine', 'keychain.node'), { identifier: `${ids.addon}.keychain`, jit: false }],
    [resources('git', 'bin', 'git'), { identifier: ids.git, jit: false }],
    [resources('git', 'libexec', 'git-core', 'git-remote-https'), { identifier: ids.gitRemoteHttps, jit: false }],
  ]);
}

// Executables of the Electron app that run V8: the main executable and the
// helper apps' executables.
function isElectronExecutable(app: string, file: string): boolean {
  const rel = relative(app, file).split(sep);
  if (rel[0] !== 'Contents') return false;
  if (rel[1] === 'MacOS' && rel.length === 3) return true;
  // Contents/Frameworks/<name> Helper….app/Contents/MacOS/<name> Helper…
  return rel[1] === 'Frameworks' && rel[2]?.endsWith('.app') === true && rel[4] === 'MacOS' && rel.length === 6;
}

export async function signApp(app: string, identity: string, ids: ReleaseIdentifiers): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dt-entitlements-'));
  const jit = entitlementsFile(dir, 'jit', [JIT_ENTITLEMENT]);
  const none = entitlementsFile(dir, 'none', []);
  const contents = join(app, 'Contents');
  const payload = payloadSigning(ids);
  const seen = new Set<string>();
  await sign({
    app,
    identity,
    platform: 'darwin',
    type: 'distribution',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: (file: string) => {
      const own = payload.get(relative(contents, file));
      if (own) {
        seen.add(relative(contents, file));
        return {
          hardenedRuntime: true,
          entitlements: own.jit ? jit : none,
          additionalArguments: ['--identifier', own.identifier],
        };
      }
      const isApp = file === app || file.endsWith('.app');
      return {
        hardenedRuntime: true,
        entitlements: isApp || isElectronExecutable(app, file) ? jit : none,
      };
    },
  });
  const unsigned = [...payload.keys()].filter((p) => !seen.has(p));
  if (unsigned.length > 0) throw new Error(`payload files not found while signing: ${unsigned.join(', ')}`);
}

// Signs a disk image (it has no entitlements or hardened runtime).
export function dmgSignArgs(identity: string, identifier: string, dmg: string): string[] {
  return ['--force', '--sign', identity, '--timestamp', '--identifier', identifier, dmg];
}
