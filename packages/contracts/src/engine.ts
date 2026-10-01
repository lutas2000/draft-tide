import { z } from 'zod';
import { EngineInstanceId, IsoTimestamp, ProjectId } from './ids.ts';

// Who is talking to the Engine. The desktop channel is the trusted GUI,
// verified by code signature (CLAUDE.md "Desktop identity"). CLI and MCP form
// the tool channel and are treated the same.
export const CHANNELS = ['desktop', 'cli', 'mcp'] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;
export type ToolChannel = Exclude<Channel, 'desktop'>;

export function isToolChannel(channel: Channel): channel is ToolChannel {
  return channel !== 'desktop';
}

// The global agent-access switch (M1 plan §9.1). Off by default and whenever
// the stored setting is missing or unreadable. Only the desktop channel can
// change it.
export const AgentAccess = z.strictObject({
  enabled: z.boolean(),
  updatedAt: IsoTimestamp.nullable(),
});
export type AgentAccess = z.infer<typeof AgentAccess>;

// A local folder bound to a project. `root` is a local absolute path: it is
// shown to local clients but never written to history or commit metadata.
export const ProjectSummary = z.strictObject({
  projectId: ProjectId,
  name: z.string().max(200),
  root: z.string().min(1).max(4096),
  boundAt: IsoTimestamp,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

// How this Engine build authenticates the desktop channel. Release builds use
// the code-signature check with the nonce handshake; development builds skip
// the signature requirement and say so.
export const DESKTOP_IDENTITY_MODES = ['code-signature', 'development'] as const;
export const DesktopIdentityMode = z.enum(DESKTOP_IDENTITY_MODES);
export type DesktopIdentityMode = z.infer<typeof DesktopIdentityMode>;

export const EngineInfo = z.strictObject({
  instanceId: EngineInstanceId,
  appVersion: z.string().max(64),
  protocolVersion: z.number().int().positive(),
  storageSchemaVersion: z.number().int().nonnegative(),
  startedAt: IsoTimestamp,
  runtime: z.strictObject({
    node: z.string().max(64),
    sqlite: z.string().max(64),
    platform: z.string().max(32),
    arch: z.string().max(32),
  }),
  desktopIdentity: DesktopIdentityMode,
  agentAccess: z.strictObject({ enabled: z.boolean() }),
  channel: Channel,
});
export type EngineInfo = z.infer<typeof EngineInfo>;
