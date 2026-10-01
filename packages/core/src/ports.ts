import type {
  AgentAccess,
  DesktopIdentityMode,
  EngineEvent,
  EngineInstanceId,
  IsoTimestamp,
  ProjectSummary,
} from '@draft-tide/contracts';

// What core needs from the outside. The Engine's composition root provides
// real implementations (local-store, Node runtime); tests may provide their
// own. Ports for Git, the filesystem and the remote provider arrive with their
// implementations (M1-02, M1-03, M1-07).

export interface Clock {
  nowIso(): IsoTimestamp;
}

// SQLite-backed local state (TECH_STACK §6.1). Not a cache: losing it must
// never be guessed around.
export interface LocalStore {
  readonly storageSchemaVersion: number;
  readonly sqliteVersion: string;
  // Missing or unreadable means off.
  getAgentAccess(): AgentAccess;
  setAgentAccess(enabled: boolean, at: IsoTimestamp): AgentAccess;
  listProjects(): ProjectSummary[];
}

// Pushes events to connected desktop sessions.
export interface EventSink {
  publish(event: EngineEvent): void;
}

// Facts about this Engine process, fixed at start.
export interface EngineIdentity {
  instanceId: EngineInstanceId;
  appVersion: string;
  startedAt: IsoTimestamp;
  desktopIdentity: DesktopIdentityMode;
  runtime: { node: string; platform: string; arch: string };
}

export interface CorePorts {
  clock: Clock;
  store: LocalStore;
  events: EventSink;
  identity: EngineIdentity;
}
