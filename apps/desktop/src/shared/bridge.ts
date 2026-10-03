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

// How an agent host reaches this installation's CLI and MCP server, and
// where the Skill is (M1 plan §4.1, 設定 / 診斷). Facts of the build and the
// data directory only; nothing here grants access, which stays the switch.
export interface AgentSetup {
  // The companion Node and the CLI bundle: `command args… <subcommand>`.
  // With a data directory other than the default, args carry --data-dir.
  command: string;
  args: string[];
  // The folder holding SKILL.md, or null when this build has none.
  skillDir: string | null;
  // The data directory, when it isn't the platform default.
  dataDir: string | null;
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
  // Puts text the app composed (the sign-in code, a setup snippet) on the
  // clipboard.
  copyText(text: string): Promise<boolean>;
  agentSetup(): Promise<AgentSetup | null>;
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
  agentSetup: 'dt:agent-setup',
  connectionState: 'dt:connection-state',
  reconnect: 'dt:reconnect',
  event: 'dt:event',
  connection: 'dt:connection',
} as const;
