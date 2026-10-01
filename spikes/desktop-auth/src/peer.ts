// Types for native/peer.c.
export interface PeerInfo {
  pid: number;
  euid: number;
  pidversion: number;
  localPeerPid: number;
}

export interface CodeCheck {
  lookupStatus: number;
  lookupError?: string;
  identifier?: string | null;
  teamId?: string | null;
  flags?: number;
  adhoc?: boolean;
  cdhash?: string;
  path?: string;
  checkStatus?: number;
  requirementStatus?: number;
  valid: boolean;
}

export interface Peer {
  peerInfo(fd: number): PeerInfo;
  checkByToken(fd: number, requirement: string): CodeCheck;
  checkByPid(fd: number, requirement: string): CodeCheck;
}
