// The whole surface the preload exposes to the GUI as `window.draftTide`.
// Main checks the sender frame and that `op` is a desktop operation before
// anything reaches the Engine.
import type { EngineEvent, Envelope } from '@draft-tide/contracts';

export type ConnectionState =
  { status: 'connecting' } | { status: 'connected'; instanceId: string } | { status: 'unavailable'; message: string };

export interface BridgeEvent {
  event: EngineEvent;
  // Events were missed; re-read everything.
  gap: boolean;
}

export interface DraftTideBridge {
  invoke(op: string, payload: unknown): Promise<Envelope<unknown>>;
  connectionState(): Promise<ConnectionState>;
  reconnect(): Promise<ConnectionState>;
  onEvent(listener: (e: BridgeEvent) => void): () => void;
  onConnection(listener: (state: ConnectionState) => void): () => void;
}

export const IPC = {
  invoke: 'dt:invoke',
  connectionState: 'dt:connection-state',
  reconnect: 'dt:reconnect',
  event: 'dt:event',
  connection: 'dt:connection',
} as const;
