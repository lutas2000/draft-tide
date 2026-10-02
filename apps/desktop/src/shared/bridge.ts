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
  // The native folder picker. A folder chosen here (and only one chosen here)
  // may then be reviewed and connected; null when the user cancels.
  // defaultPath (absolute) is only where the dialog opens, for example the
  // folder an agent asked for; it grants nothing.
  chooseFolder(defaultPath?: string): Promise<string | null>;
  // Opens a GitHub page in the user's browser (signing in, creating a repo,
  // installing the app). Only https://github.com/ pages; false otherwise.
  openExternal(url: string): Promise<boolean>;
  // Puts a short single line (the sign-in code) on the clipboard.
  copyText(text: string): Promise<boolean>;
  connectionState(): Promise<ConnectionState>;
  reconnect(): Promise<ConnectionState>;
  onEvent(listener: (e: BridgeEvent) => void): () => void;
  onConnection(listener: (state: ConnectionState) => void): () => void;
}

export const IPC = {
  invoke: 'dt:invoke',
  chooseFolder: 'dt:choose-folder',
  openExternal: 'dt:open-external',
  copyText: 'dt:copy-text',
  connectionState: 'dt:connection-state',
  reconnect: 'dt:reconnect',
  event: 'dt:event',
  connection: 'dt:connection',
} as const;
