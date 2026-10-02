import { z } from 'zod';
import { AgentAccess, Channel } from './engine.ts';
import { ErrorCodeSchema, ErrorInfo } from './errors.ts';
import { EngineInstanceId, OperationId, ProjectId, RequestId } from './ids.ts';
import { LoginOutcome } from './remote.ts';
import { RestoreProgress } from './restore.ts';
import { Origin, SaveProgress } from './snapshot.ts';
import { SyncProgress } from './sync.ts';

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

// Long operations the Engine reports while they run.
export const PROGRESS_OPERATIONS = [
  'snapshot.create',
  'restore.apply',
  'recovery.apply',
  'remote.connectApply',
  'sync.push',
  'sync.pullApply',
  'remote.openApply',
] as const;
const ProgressOperation = z.enum(PROGRESS_OPERATIONS);

//   completed           done
//   no-changes          nothing needed doing (NO_CHANGES)
//   failed              stopped with the given code; see operation.status
//   cancelled           stopped at a safe boundary on request
//   recovery-required   stopped part-way; recovery completes or undoes it
export const SETTLED_OUTCOMES = ['completed', 'no-changes', 'failed', 'cancelled', 'recovery-required'] as const;

export const EngineEvent = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('agentAccess.changed'), agentAccess: AgentAccess }),
  // A project was connected, or its history or folder changed through any
  // channel: re-read its status and history.
  z.strictObject({
    name: z.literal('project.changed'),
    projectId: ProjectId,
    reason: z.enum(['bound', 'saved', 'restored', 'recovered', 'pulled']),
  }),
  // Throttled; every stage change is reported. Carries no file names. A
  // restore or recovery reports RestoreProgress, a save SaveProgress, a sync
  // operation SyncProgress.
  z.strictObject({
    name: z.literal('operation.progress'),
    operationId: OperationId,
    projectId: ProjectId,
    operation: ProgressOperation,
    origin: Origin,
    progress: z.union([SaveProgress, RestoreProgress, SyncProgress]),
  }),
  // The operation ended (or stopped part-way). Status and history say what
  // is true now.
  z.strictObject({
    name: z.literal('operation.settled'),
    operationId: OperationId,
    projectId: ProjectId,
    operation: ProgressOperation,
    origin: Origin,
    outcome: z.enum(SETTLED_OUTCOMES),
    code: ErrorCodeSchema.nullable(),
  }),
  // Agent requests, notices or operations needing recovery came or went:
  // re-read operation.list.
  z.strictObject({ name: z.literal('operations.changed') }),
  // Sign-in changed: re-read auth.status. login says how a device login the
  // app started ended.
  z.strictObject({ name: z.literal('auth.changed'), login: LoginOutcome.nullable() }),
  // A project's remote or sync state changed: re-read remote.status.
  z.strictObject({ name: z.literal('remote.changed'), projectId: ProjectId }),
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
