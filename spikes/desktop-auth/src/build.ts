// Builds the peer addon and the signed stand-in clients with Xcode's clang.
// No node-gyp: N-API symbols resolve at load time (-undefined dynamic_lookup).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DESKTOP_ID = 'dev.drafttide.spike.desktop';
export const ATTACKER_ID = 'dev.drafttide.spike.attacker';
export const TEAM_NODE_ID = 'dev.drafttide.spike.companion-node';

// Optional real identities (SHA-1 or name from `security find-identity`):
//   devId    Developer ID Application: signs the desktop stand-in, the addon
//            and a team copy of the companion Node, with hardened runtime
//   appleDev Apple Development: signs another stand-in with the desktop's
//            identifier, to show what `anchor apple generic` alone admits
export interface Identities {
  devId?: string;
  appleDev?: string;
  bundledNode?: string;
}

export interface Built {
  addon: string;
  desktopSim: string;
  forged: string;
  attacker: string;
  desktopCdhash: string;
  forgedCdhash: string;
  teamNode?: string;
  teamNodeLoose?: string;
  appleDevSigned?: string;
  adhocAddon?: string;
  taskport?: string;
  injectLib?: string;
}

function nodeInclude(): string {
  // Headers ship with a full Node install (nvm, Homebrew). The bundled
  // companion Node in the M0 app has none; N-API keeps the addon ABI-stable.
  const candidates = [process.env['NODE_INCLUDE'], join(dirname(dirname(process.execPath)), 'include', 'node')];
  for (const c of candidates) if (c && existsSync(join(c, 'node_api.h'))) return c;
  throw new Error('node_api.h not found; set NODE_INCLUDE');
}

// codesign writes its report to stderr.
function cdhash(bin: string): string {
  const r = execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dvvv "$1" 2>&1', 'sh', bin], { encoding: 'utf8' });
  const m = /^CDHash=([0-9a-f]+)$/m.exec(r);
  if (!m?.[1]) throw new Error(`no CDHash for ${bin}: ${r}`);
  return m[1];
}

function sign(bin: string, identifier: string): void {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, bin], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// A release-style signature: hardened runtime, secure timestamp, and only the
// entitlements given (never get-task-allow).
export function signWith(identity: string, bin: string, identifier: string, entitlements?: string): void {
  const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--identifier', identifier];
  if (entitlements) args.push('--entitlements', entitlements);
  execFileSync('/usr/bin/codesign', [...args, bin], { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function entitlementsFile(dir: string, name: string, keys: string[]): string {
  const f = join(dir, `${name}.plist`);
  const body = keys.map((k) => `  <key>${k}</key><true/>`).join('\n');
  writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`);
  return f;
}

export function build(root: string, ids: Identities = {}): Built {
  const out = join(root, '.work', 'build');
  mkdirSync(out, { recursive: true });
  // xcrun supplies the SDK root; the bare toolchain clang has none.
  const clang = (args: string[]) => execFileSync('/usr/bin/xcrun', ['clang', ...args], { stdio: 'inherit' });
  const addon = join(out, 'peer.node');
  clang(['-O2', '-Wall', '-bundle', '-undefined', 'dynamic_lookup', '-DNODE_GYP_MODULE_NAME=peer', `-I${nodeInclude()}`, join(root, 'native', 'peer.c'), '-framework', 'Security', '-framework', 'CoreFoundation', '-lbsm', '-o', addon]);

  const plain = join(out, 'client');
  const variant = join(out, 'client-variant');
  clang(['-O2', '-Wall', join(root, 'native', 'client.c'), '-o', plain]);
  clang(['-O2', '-Wall', '-DVARIANT="forged"', join(root, 'native', 'client.c'), '-o', variant]);

  const desktopSim = join(out, 'desktop-sim');
  const forged = join(out, 'forged');
  const attacker = join(out, 'attacker');
  copyFileSync(plain, desktopSim);
  copyFileSync(variant, forged);
  copyFileSync(plain, attacker);
  sign(forged, DESKTOP_ID); // same identifier, different code
  sign(attacker, ATTACKER_ID);
  const built: Built = { addon, desktopSim, forged, attacker, desktopCdhash: '', forgedCdhash: '' };
  if (!ids.devId) {
    sign(desktopSim, DESKTOP_ID);
  } else {
    signWith(ids.devId, desktopSim, DESKTOP_ID);
    // The addon is loaded by Nodes under library validation, so it carries the
    // team's signature. An ad-hoc copy shows what library validation refuses.
    const adhocAddon = join(out, 'peer-adhoc.node');
    copyFileSync(addon, adhocAddon);
    sign(adhocAddon, 'peer-adhoc');
    signWith(ids.devId, addon, 'dev.drafttide.spike.peer');
    built.adhocAddon = adhocAddon;
    if (ids.bundledNode) {
      // The companion Node re-signed by the team under its own identifier,
      // with only JIT (no get-task-allow, dyld variables or library exemption).
      const teamNode = join(out, 'node-team');
      copyFileSync(ids.bundledNode, teamNode);
      signWith(ids.devId, teamNode, TEAM_NODE_ID, entitlementsFile(out, 'node', ['com.apple.security.cs.allow-jit']));
      built.teamNode = teamNode;
      // Same, plus disable-library-validation, to show what that exemption admits.
      const loose = join(out, 'node-team-loose');
      copyFileSync(ids.bundledNode, loose);
      signWith(ids.devId, loose, TEAM_NODE_ID, entitlementsFile(out, 'node-loose', ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']));
      built.teamNodeLoose = loose;
    }
  }
  if (ids.appleDev) {
    const appleDevSigned = join(out, 'desktop-appledev');
    copyFileSync(variant, appleDevSigned);
    signWith(ids.appleDev, appleDevSigned, DESKTOP_ID);
    built.appleDevSigned = appleDevSigned;
  }
  if (ids.devId) {
    // Attacker-side probes for the hardened-runtime checks. The task-port probe
    // is ad-hoc signed with the debugger entitlement, which anyone can do.
    const taskport = join(out, 'taskport');
    clang(['-O2', '-Wall', join(root, 'native', 'taskport.c'), '-o', taskport]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlementsFile(out, 'debugger', ['com.apple.security.cs.debugger']), taskport], { stdio: ['ignore', 'ignore', 'pipe'] });
    const injectLib = join(out, 'inject.dylib');
    clang(['-O2', '-Wall', '-dynamiclib', join(root, 'native', 'inject.c'), '-o', injectLib]);
    sign(injectLib, 'inject');
    built.taskport = taskport;
    built.injectLib = injectLib;
  }
  built.desktopCdhash = cdhash(desktopSim);
  built.forgedCdhash = cdhash(forged);
  return built;
}
