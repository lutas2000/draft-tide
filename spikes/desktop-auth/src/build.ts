// Builds the peer addon and the signed stand-in clients with Xcode's clang.
// No node-gyp: N-API symbols resolve at load time (-undefined dynamic_lookup).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DESKTOP_ID = 'dev.drafttide.spike.desktop';
export const ATTACKER_ID = 'dev.drafttide.spike.attacker';

export interface Built {
  addon: string;
  desktopSim: string;
  forged: string;
  attacker: string;
  desktopCdhash: string;
  forgedCdhash: string;
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

export function build(root: string): Built {
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
  sign(desktopSim, DESKTOP_ID);
  sign(forged, DESKTOP_ID); // same identifier, different code
  sign(attacker, ATTACKER_ID);
  return { addon, desktopSim, forged, attacker, desktopCdhash: cdhash(desktopSim), forgedCdhash: cdhash(forged) };
}
