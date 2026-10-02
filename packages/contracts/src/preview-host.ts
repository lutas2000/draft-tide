import { z } from 'zod';
import { PreviewBlockedKind, PreviewImageKind, PreviewSettings, PreviewSubject } from './preview.ts';

// The private pipe between the Engine and a Preview Host process (TECH_STACK
// §10.1). The Engine starts the app binary in Preview Host mode and talks to
// it over one inherited pipe (fd 3), never a socket or port: the host gets one
// job at a time and the files that job's page asks for, and nothing else (no
// data directory, database, Git, tokens or Engine channel).
//
// Each frame is a 4-byte big-endian header length, a 4-byte big-endian body
// length, the header (UTF-8 JSON, one of the messages below) and the body
// (raw bytes: a served file or a PNG).
export const PREVIEW_HOST_PROTOCOL = 1;
export const PREVIEW_HOST_MAX_HEADER_BYTES = 256 * 1024;
// A served file is within PREVIEW_BUDGET.fileBytes; a PNG of the largest
// image box is well within this too.
export const PREVIEW_HOST_MAX_BODY_BYTES = 64 * 1024 * 1024;

// Started as `<app> --dt-preview-host` (plus the development app path).
export const PREVIEW_HOST_FLAG = '--dt-preview-host';
// The host's private scratch directory (user data, caches), made and removed
// by the Engine.
export const PREVIEW_HOST_SCRATCH_ENV = 'DT_PREVIEW_SCRATCH';

const JobId = z.uuid();
const RequestNo = z.number().int().nonnegative();

// ---- Engine → host

const Size = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });

export const HostJob = z.strictObject({
  type: z.literal('job'),
  jobId: JobId,
  subject: PreviewSubject,
  settings: PreviewSettings,
  // The exact sizes of the two PNGs (decided by the Engine).
  output: Size,
  thumbnail: Size,
  // The host reports `timeout` when the page isn't captured by then.
  timeoutMs: z.number().int().positive(),
});
export type HostJob = z.infer<typeof HostJob>;

// The answer to one fetch. Only `ok` carries a body.
export const HostFile = z.strictObject({
  type: z.literal('file'),
  jobId: JobId,
  requestId: RequestNo,
  status: z.enum(['ok', 'missing']),
  contentType: z.string().max(128).optional(),
});
export type HostFile = z.infer<typeof HostFile>;

export const HostExit = z.strictObject({ type: z.literal('exit') });

export const EngineToHost = z.discriminatedUnion('type', [HostJob, HostFile, HostExit]);
export type EngineToHost = z.infer<typeof EngineToHost>;

// ---- host → Engine

export const HostReady = z.strictObject({
  type: z.literal('ready'),
  protocol: z.number().int().positive(),
  electron: z.string().max(32),
  chromium: z.string().max(32),
  platform: z.string().max(32),
  osRelease: z.string().max(64),
});
export type HostReady = z.infer<typeof HostReady>;

// A request from the page for dt-preview://job/<path>. The path is the URL's
// pathname as Chromium normalized it, still percent-encoded: the Engine
// decodes and checks it.
export const HostFetch = z.strictObject({
  type: z.literal('fetch'),
  jobId: JobId,
  requestId: RequestNo,
  path: z.string().max(8192),
});
export type HostFetch = z.infer<typeof HostFetch>;

// One captured PNG (the body).
export const HostImage = z.strictObject({
  type: z.literal('image'),
  jobId: JobId,
  image: PreviewImageKind,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type HostImage = z.infer<typeof HostImage>;

export const HOST_OUTCOMES = ['captured', 'load-failed', 'capture-failed', 'timeout'] as const;

export const HostDone = z.strictObject({
  type: z.literal('done'),
  jobId: JobId,
  outcome: z.enum(HOST_OUTCOMES),
  message: z.string().max(1000).optional(),
  // What the page tried and was stopped from doing. Raw targets: the Engine
  // makes them printable.
  blocked: z.strictObject({
    count: z.number().int().nonnegative(),
    entries: z.array(z.strictObject({ kind: PreviewBlockedKind, target: z.string().max(2048) })).max(100),
  }),
});
export type HostDone = z.infer<typeof HostDone>;

export const HostToEngine = z.discriminatedUnion('type', [HostReady, HostFetch, HostImage, HostDone]);
export type HostToEngine = z.infer<typeof HostToEngine>;

// The renderer a Preview Host reports, as the Engine names it in cache keys.
// Whoever tells the Engine where its Preview Host is also states this, so the
// Engine knows it before the first render, and checks it against the host's
// own report.
export function previewRendererId(electron: string, chromium: string): string {
  return `electron/${electron} chromium/${chromium}`;
}

// Development and e2e builds only: how the Engine starts its Preview Host,
// given by the launcher in DRAFT_TIDE_PREVIEW_HOST (release builds derive it
// from the app bundle, M1-09).
export const PREVIEW_HOST_ENV = 'DRAFT_TIDE_PREVIEW_HOST';
export const PreviewHostLaunch = z.strictObject({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(8),
  renderer: z.string().min(1).max(128),
});
export type PreviewHostLaunch = z.infer<typeof PreviewHostLaunch>;
