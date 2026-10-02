import { z } from 'zod';
import { VersionInfo, VersionRef } from './history.ts';
import { ArtifactId, IsoTimestamp, ProjectId } from './ids.ts';
import { RelativePath } from './project-config.ts';

// Previews (M1 plan §2.3, §8; TECH_STACK §10). A version's entry page, or one
// of its PNG/JPEG files, rendered by the isolated Preview Host into a PNG and
// a thumbnail. Previews are a rebuildable cache: a failed or incomplete
// preview never changes or undoes a version, and nothing here is a restore
// input. Budgets in this file limit previews only, never what is saved.

const DisplayPath = z.string().max(4096);
const Count = z.number().int().nonnegative();

// ---- Render settings (M1: fixed, recorded, part of every cache key)

export const PREVIEW_VIEWPORT = { width: 1280, height: 800, scale: 1 } as const;
export const PREVIEW_THUMBNAIL = { width: 400, height: 250 } as const;
// An image preview keeps its aspect ratio and fits in this box.
export const PREVIEW_IMAGE_BOX = { width: 1600, height: 1600 } as const;
export const PREVIEW_LOCALE = 'en-US';
// After the load event: web fonts ready, two animation frames, then this long
// for scripts that render late.
export const PREVIEW_SETTLE_MS = 300;
// CSS animations and transitions jump to their end state.
export const PREVIEW_WAIT = 'load+fonts+2-frames+300ms';
export const PREVIEW_ANIMATIONS = 'jump-to-end';

export const PreviewSettings = z.strictObject({
  viewport: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive(),
  }),
  thumbnail: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  locale: z.string().max(64),
  // IANA name of the time zone pages see (the computer's own).
  timezone: z.string().max(64),
  // Scripts run: the user connected the folder, so its pages are the user's
  // own design (M1-06). Network stays blocked either way.
  scripts: z.boolean(),
  wait: z.string().max(64),
  animations: z.string().max(64),
});
export type PreviewSettings = z.infer<typeof PreviewSettings>;

// What rendered it, as the Preview Host reported it.
export const PreviewEnvironment = z.strictObject({
  renderer: z.string().max(128),
  electron: z.string().max(32),
  chromium: z.string().max(32),
  platform: z.string().max(32),
  osRelease: z.string().max(64),
});
export type PreviewEnvironment = z.infer<typeof PreviewEnvironment>;

// ---- Budgets (previews only; never a limit on saving)

export interface PreviewBudget {
  fileBytes: number;
  totalBytes: number;
  requests: number;
  timeoutMs: number;
  imagePixels: number;
  queue: number;
  cacheBytes: number;
}

export const PREVIEW_BUDGET: Readonly<PreviewBudget> = {
  // One file served to a page.
  fileBytes: 32 * 1024 * 1024,
  // Everything served to one render.
  totalBytes: 256 * 1024 * 1024,
  requests: 2_000,
  // From the job's start to the captured image.
  timeoutMs: 20_000,
  // An image subject is decoded only within this many pixels.
  imagePixels: 50_000_000,
  // Renders waiting for the Preview Host.
  queue: 64,
  // The rebuildable cache of every project of this data store.
  cacheBytes: 256 * 1024 * 1024,
};

// How long an artifact id may be used to read its images.
export const PREVIEW_ARTIFACT_TTL_MS = 30 * 60 * 1000;
// One preview.read answer carries at most this many bytes (base64 in JSON,
// well within one control message).
export const PREVIEW_READ_CHUNK_BYTES = 512 * 1024;

// What a page may be served, by extension. Anything else is not served (and
// is listed as missing). The Preview Host also only ever receives these.
export const PREVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

// The lowercase extension of a path's last segment; none for `.htaccess`.
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

export function previewContentType(path: string): string | null {
  const ext = extensionOf(path);
  return ext !== null && Object.hasOwn(PREVIEW_CONTENT_TYPES, ext) ? (PREVIEW_CONTENT_TYPES[ext] ?? null) : null;
}

export const PAGE_EXTENSIONS: readonly string[] = ['html', 'htm'];
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg'];

export function previewKindOf(path: string): 'page' | 'image' | null {
  const ext = extensionOf(path);
  if (ext !== null && PAGE_EXTENSIONS.includes(ext)) return 'page';
  if (ext !== null && IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return null;
}

// ---- Stable reasons

// PREVIEW_UNSUPPORTED: this version (or file) has nothing Draft Tide can
// preview. Retrying won't help; it says what to change.
//   no-settings      the version has no .drafttide.json
//   settings-invalid the version's .drafttide.json can't be read
//   no-entry         its settings name no entry page
//   entry-missing    the entry page isn't in the version
//   entry-type       the entry is neither HTML nor PNG/JPEG
//   file-missing     the file asked for isn't in the version
//   file-type        the file asked for isn't a PNG or JPEG
//   not-a-file       a symlink or gitlink another tool committed
//   image-invalid    the bytes are not a PNG/JPEG Draft Tide can read
//   image-too-large  over the decode budget (pixels or bytes)
export const PREVIEW_UNSUPPORTED_REASONS = [
  'no-settings',
  'settings-invalid',
  'no-entry',
  'entry-missing',
  'entry-type',
  'file-missing',
  'file-type',
  'not-a-file',
  'image-invalid',
  'image-too-large',
] as const;
export const PreviewUnsupportedReason = z.enum(PREVIEW_UNSUPPORTED_REASONS);
export type PreviewUnsupportedReason = z.infer<typeof PreviewUnsupportedReason>;

// PREVIEW_FAILED: the render didn't produce an image. The version is
// untouched.
//   no-renderer       this Engine has no Preview Host (development Engines
//                     started without one; release builds until M1-09)
//   queue-full        too many renders waiting; try again
//   timeout           the page didn't finish within the time budget
//   crashed           the Preview Host stopped
//   load-failed       the page couldn't be loaded
//   capture-failed    the page loaded but no image came back
//   invalid-output    the Preview Host's image didn't check out
//   renderer-mismatch the Preview Host isn't the renderer this Engine expects
export const PREVIEW_FAILED_REASONS = [
  'no-renderer',
  'queue-full',
  'timeout',
  'crashed',
  'load-failed',
  'capture-failed',
  'invalid-output',
  'renderer-mismatch',
] as const;
export const PreviewFailedReason = z.enum(PREVIEW_FAILED_REASONS);
export type PreviewFailedReason = z.infer<typeof PreviewFailedReason>;

// Retrying the same render may work.
export const RETRYABLE_PREVIEW_FAILURES: ReadonlySet<PreviewFailedReason> = new Set([
  'queue-full',
  'timeout',
  'crashed',
]);

// Why a file a page asked for wasn't served.
//   not-in-version  no such file in the version
//   not-a-file      a folder, symlink or gitlink
//   type            not a type previews serve
//   too-large       over the per-file budget
//   budget          the render's total bytes or requests ran out
//   invalid-path    not a path inside the project (`..`, encoded tricks…)
export const PREVIEW_MISSING_REASONS = [
  'not-in-version',
  'not-a-file',
  'type',
  'too-large',
  'budget',
  'invalid-path',
] as const;
export const PreviewMissingReason = z.enum(PREVIEW_MISSING_REASONS);
export type PreviewMissingReason = z.infer<typeof PreviewMissingReason>;

// What the Preview Host stopped the page from doing.
export const PREVIEW_BLOCKED_KINDS = ['network', 'navigation', 'popup', 'permission', 'download'] as const;
export const PreviewBlockedKind = z.enum(PREVIEW_BLOCKED_KINDS);
export type PreviewBlockedKind = z.infer<typeof PreviewBlockedKind>;

// Samples are made printable and cut short before they leave the Engine:
// they come from the page.
export const PREVIEW_SAMPLE_MAX = 20;
export const PREVIEW_SAMPLE_CHARS = 200;

export const PreviewMissing = z.strictObject({
  count: Count,
  entries: z
    .array(z.strictObject({ path: z.string().max(PREVIEW_SAMPLE_CHARS), reason: PreviewMissingReason }))
    .max(PREVIEW_SAMPLE_MAX),
});
export type PreviewMissing = z.infer<typeof PreviewMissing>;

export const PreviewBlocked = z.strictObject({
  count: Count,
  entries: z
    .array(z.strictObject({ kind: PreviewBlockedKind, target: z.string().max(PREVIEW_SAMPLE_CHARS) }))
    .max(PREVIEW_SAMPLE_MAX),
});
export type PreviewBlocked = z.infer<typeof PreviewBlocked>;

// ---- What a preview shows

//   page   the version's entry page (the first entry file of its own
//          .drafttide.json)
//   image  a PNG or JPEG of the version, at most PREVIEW_IMAGE_BOX
export const PreviewSubject = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), path: DisplayPath }),
  z.strictObject({
    kind: z.literal('image'),
    path: DisplayPath,
    // As stored in the file.
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
]);
export type PreviewSubject = z.infer<typeof PreviewSubject>;

export const PreviewImage = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: Count,
  // Of the PNG: equal hashes mean the same picture.
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PreviewImage = z.infer<typeof PreviewImage>;

// A rendered preview as the cache keeps it (local state, not a public DTO).
export const PreviewRecord = z.strictObject({
  subject: PreviewSubject,
  image: PreviewImage,
  thumbnail: PreviewImage,
  renderedAt: IsoTimestamp,
  missing: PreviewMissing,
  blocked: PreviewBlocked,
  settings: PreviewSettings,
  environment: PreviewEnvironment,
});
export type PreviewRecord = z.infer<typeof PreviewRecord>;

// The artifact reference a caller gets (M1 plan §11.2): bound to the
// project, valid until expiresAt, readable only through preview.read. It is
// never a path.
export const PreviewArtifact = z.strictObject({
  artifactId: ArtifactId,
  projectId: ProjectId,
  expiresAt: IsoTimestamp,
  version: VersionInfo,
  subject: PreviewSubject,
  image: PreviewImage,
  thumbnail: PreviewImage,
  renderedAt: IsoTimestamp,
  // From the cache, not rendered for this call.
  cached: z.boolean(),
  missing: PreviewMissing,
  blocked: PreviewBlocked,
  // Something was missing or blocked: the picture may not be what the
  // designer sees with the network on.
  incomplete: z.boolean(),
  settings: PreviewSettings,
  environment: PreviewEnvironment,
});
export type PreviewArtifact = z.infer<typeof PreviewArtifact>;

export const SnapshotPreviewInput = z.strictObject({
  projectId: ProjectId,
  version: VersionRef,
  // A PNG or JPEG of the version instead of its entry page.
  file: RelativePath.optional(),
});

export const PREVIEW_IMAGE_KINDS = ['full', 'thumbnail'] as const;
export const PreviewImageKind = z.enum(PREVIEW_IMAGE_KINDS);
export type PreviewImageKind = z.infer<typeof PreviewImageKind>;

export const PreviewReadInput = z.strictObject({
  projectId: ProjectId,
  artifactId: ArtifactId,
  image: PreviewImageKind,
  offset: Count.max(Number.MAX_SAFE_INTEGER).optional(),
});

export const PreviewChunk = z.strictObject({
  artifactId: ArtifactId,
  image: PreviewImageKind,
  offset: Count,
  // The whole PNG.
  size: Count,
  // Base64 of at most PREVIEW_READ_CHUNK_BYTES bytes.
  data: z.string().max(Math.ceil(PREVIEW_READ_CHUNK_BYTES / 3) * 4),
  done: z.boolean(),
});
export type PreviewChunk = z.infer<typeof PreviewChunk>;

export const PreviewStatus = z.strictObject({
  // This Engine can render.
  available: z.boolean(),
  renderer: z.string().max(128).nullable(),
  settings: PreviewSettings,
  queue: z.strictObject({ waiting: Count, running: Count }),
  cache: z.strictObject({ entries: Count, bytes: Count, budgetBytes: Count }),
});
export type PreviewStatus = z.infer<typeof PreviewStatus>;

export const PreviewCacheCleared = z.strictObject({ entries: Count, bytes: Count });
export type PreviewCacheCleared = z.infer<typeof PreviewCacheCleared>;
