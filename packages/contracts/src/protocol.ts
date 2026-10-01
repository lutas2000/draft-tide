import { z } from 'zod';
import { AgentAccess, Channel } from './engine.ts';
import { ErrorCodeSchema, ErrorInfo } from './errors.ts';
import { EngineInstanceId, OperationId, ProjectId, RequestId } from './ids.ts';
import { Origin, SaveProgress } from './snapshot.ts';

// Engine protocol: length-framed JSON over a Unix domain socket or Windows
// named pipe (TECH_STACK §3.2). No HTTP. A 4-byte big-endian length precedes
// each UTF-8 JSON message.
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

const Nonce = z.string().regex(/^[0-9a-f]{64}$/);
const ClientIdent = z.strictObject({
  name: z.string().max(64),
  version: z.string().max(64),
});

// ---- client → Engine

// First message on every connection. The desktop channel then gets a
// challenge; the tool channel presents the token from the discovery file.
export const Hello = z.strictObject({
  type: z.literal('hello'),
  protocolVersion: z.number().int().positive(),
  channel: Channel,
  client: ClientIdent,
  toolToken: z.string().max(128).optional(),
});
export type Hello = z.infer<typeof Hello>;

// Desktop only: echo the nonce from the same process instance that said hello.
export const ChallengeResponse = z.strictObject({
  type: z.literal('challenge-response'),
  nonce: Nonce,
});
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;

export const RequestMessage = z.strictObject({
  type: z.literal('request'),
  requestId: RequestId,
  op: z.string().min(1).max(128),
  // Validated per operation against the catalog's input schema.
  payload: z.unknown(),
});
export type RequestMessage = z.infer<typeof RequestMessage>;

export const ClientMessage = z.discriminatedUnion('type', [Hello, ChallengeResponse, RequestMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- Engine → client

export const Challenge = z.strictObject({
  type: z.literal('challenge'),
  nonce: Nonce,
});
export type Challenge = z.infer<typeof Challenge>;

export const Welcome = z.strictObject({
  type: z.literal('welcome'),
  instanceId: EngineInstanceId,
  protocolVersion: z.number().int().positive(),
  channel: Channel,
  // Operations this session may call (before agent-access checks).
  operations: z.array(z.string()),
});
export type Welcome = z.infer<typeof Welcome>;

// The handshake failed; the Engine closes the connection after sending it.
export const Rejected = z.strictObject({
  type: z.literal('rejected'),
  error: ErrorInfo,
});
export type Rejected = z.infer<typeof Rejected>;

export const ResponseMessage = z.union([
  z.strictObject({ type: z.literal('response'), requestId: RequestId, ok: z.literal(true), data: z.unknown() }),
  z.strictObject({ type: z.literal('response'), requestId: RequestId, ok: z.literal(false), error: ErrorInfo }),
]);
export type ResponseMessage = z.infer<typeof ResponseMessage>;

// Long operations the Engine reports while they run. Only saving in M1-04.
export const PROGRESS_OPERATIONS = ['snapshot.create'] as const;
const ProgressOperation = z.enum(PROGRESS_OPERATIONS);

export const EngineEvent = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('agentAccess.changed'), agentAccess: AgentAccess }),
  // A project was connected, or a version saved through any channel: re-read
  // its status and history.
  z.strictObject({
    name: z.literal('project.changed'),
    projectId: ProjectId,
    reason: z.enum(['bound', 'saved']),
  }),
  // Throttled; every stage change is reported. Carries no file names.
  z.strictObject({
    name: z.literal('operation.progress'),
    operationId: OperationId,
    projectId: ProjectId,
    operation: ProgressOperation,
    origin: Origin,
    progress: SaveProgress,
  }),
  // The operation ended: completed, nothing to do (NO_CHANGES), or failed with
  // the given code. Status and history say what is true now.
  z.strictObject({
    name: z.literal('operation.settled'),
    operationId: OperationId,
    projectId: ProjectId,
    operation: ProgressOperation,
    origin: Origin,
    outcome: z.enum(['completed', 'no-changes', 'failed']),
    code: ErrorCodeSchema.nullable(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

// Events carry a per-Engine sequence number. A gap means the client missed
// something and must re-read state; events never decide whether data is done.
export const EventMessage = z.strictObject({
  type: z.literal('event'),
  seq: z.number().int().positive(),
  event: EngineEvent,
});
export type EventMessage = z.infer<typeof EventMessage>;

export const EngineMessage = z.union([Challenge, Welcome, Rejected, ResponseMessage, EventMessage]);
export type EngineMessage = z.infer<typeof EngineMessage>;

// Written by the Engine (0600, inside the 0700 runtime directory) once it
// listens. Clients use it to find the socket; the tool token is in it.
export const Discovery = z.strictObject({
  pid: z.number().int().positive(),
  instanceId: EngineInstanceId,
  protocolVersion: z.number().int().positive(),
  socket: z.string().min(1).max(1024),
  toolToken: z.string().min(32).max(128),
  startedAt: z.string(),
});
export type Discovery = z.infer<typeof Discovery>;
