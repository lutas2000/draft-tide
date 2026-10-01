import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopIdentityMode } from '@draft-tide/contracts';

// Desktop identity (CLAUDE.md "Desktop identity"): the Engine checks who is on
// the other end of a desktop connection by code signature, and pins that
// process instance for the whole session.

export interface PeerInstance {
  pid: number;
  pidversion: number;
}

export type PinResult = { ok: true; instance: PeerInstance | null } | { ok: false; reason: string };

export interface PeerVerifier {
  readonly mode: DesktopIdentityMode;
  // At hello: check the peer and pin its instance (T0).
  pin(socket: Socket): PinResult;
  // At the nonce echo and on every later message: still the T0 instance?
  sameInstance(socket: Socket, t0: PeerInstance | null): boolean;
}

interface PeerAddon {
  peerInstance(fd: number): PeerInstance & { euid: number };
  checkRequirement(
    fd: number,
    requirement: string,
  ): PeerInstance & { valid: boolean; status: number; identifier?: string | null; teamId?: string | null };
}

const ADDON_FILE = 'peer-identity.node';

// Next to the bundled engine.mjs (dist/native), or the dev build when running
// from source.
function findAddon(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'native', ADDON_FILE), join(here, '..', '..', 'dist', 'native', ADDON_FILE)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadAddon(): PeerAddon | null {
  if (process.platform !== 'darwin') return null;
  const file = findAddon();
  if (!file) return null;
  return createRequire(import.meta.url)(file) as PeerAddon;
}

// Node keeps the descriptor on the socket's internal handle.
function fdOf(socket: Socket): number {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) throw new Error('socket has no file descriptor');
  return fd;
}

export function createPeerVerifier(requirement: string | null, log: (msg: string) => void): PeerVerifier {
  let addon: PeerAddon | null = null;
  let loadError: string | null = null;
  try {
    addon = loadAddon();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  const instanceOf = (socket: Socket): PeerInstance | null => {
    if (!addon) return null;
    const p = addon.peerInstance(fdOf(socket));
    return { pid: p.pid, pidversion: p.pidversion };
  };
  const same = (socket: Socket, t0: PeerInstance | null): boolean => {
    if (!t0) return addon === null;
    try {
      const now = instanceOf(socket);
      return now !== null && now.pid === t0.pid && now.pidversion === t0.pidversion;
    } catch {
      return false;
    }
  };

  if (requirement !== null) {
    // Release build: no addon or the wrong platform means no desktop session
    // at all, never a weaker check.
    if (!addon)
      log(
        `desktop identity unavailable (${loadError ?? 'peer-identity addon not found'}); refusing desktop connections`,
      );
    return {
      mode: 'code-signature',
      pin(socket) {
        if (!addon) return { ok: false, reason: 'desktop identity check unavailable' };
        try {
          const fd = fdOf(socket);
          const check = addon.checkRequirement(fd, requirement);
          if (!check.valid) {
            log(
              `desktop rejected: identifier=${check.identifier ?? '-'} team=${check.teamId ?? '-'} status=${check.status}`,
            );
            return { ok: false, reason: 'the app failed the code-signature check' };
          }
          return { ok: true, instance: { pid: check.pid, pidversion: check.pidversion } };
        } catch (e) {
          return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
      },
      sameInstance: same,
    };
  }

  // Development build: no signature requirement. Instance pinning still runs
  // where the addon is available, so the handshake path is exercised.
  log(
    addon
      ? 'development build: desktop signature not checked; instance pinning on'
      : `development build: desktop signature not checked; instance pinning off (${loadError ?? 'no addon on this platform'})`,
  );
  return {
    mode: 'development',
    pin(socket) {
      try {
        return { ok: true, instance: instanceOf(socket) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    sameInstance: same,
  };
}
