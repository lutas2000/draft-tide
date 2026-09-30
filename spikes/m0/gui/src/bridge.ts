/**
 * Optional host bridge. When this GUI runs inside the M0 Electron spike, the
 * restricted preload exposes `window.draftTide`. In a plain browser it is
 * absent and the app runs on example data only.
 */
export interface EngineInfo {
  instanceId: string;
  pid: number;
  protocolVersion: number;
  nodeVersion: string;
  sqliteVersion: string;
  gitVersion: string;
  gitPath: string;
  dataDir: string;
}

declare global {
  interface Window {
    draftTide?: {
      engineInfo(): Promise<EngineInfo>;
    };
  }
}

export type EngineProbe =
  | { state: 'web' }
  | { state: 'loading' }
  | { state: 'ok'; info: EngineInfo }
  | { state: 'error'; message: string };

export function hasHostBridge(): boolean {
  return typeof window !== 'undefined' && window.draftTide !== undefined;
}

export async function probeEngine(): Promise<EngineProbe> {
  const bridge = window.draftTide;
  if (!bridge) return { state: 'web' };
  try {
    const info = await bridge.engineInfo();
    return { state: 'ok', info };
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
