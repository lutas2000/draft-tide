import {
  ArtifactId,
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  PREVIEW_ANIMATIONS,
  PREVIEW_ARTIFACT_TTL_MS,
  PREVIEW_BUDGET,
  PREVIEW_IMAGE_BOX,
  PREVIEW_LOCALE,
  PREVIEW_READ_CHUNK_BYTES,
  PREVIEW_SAMPLE_CHARS,
  PREVIEW_SAMPLE_MAX,
  PREVIEW_THUMBNAIL,
  PREVIEW_VIEWPORT,
  PREVIEW_WAIT,
  PROJECT_CONFIG_FILE,
  PreviewRecord,
  RETRYABLE_PREVIEW_FAILURES,
  canonicalJson,
  isSafeRelativePath,
  parseProjectConfig,
  previewContentType,
  previewKindOf,
  type IsoTimestamp,
  type PreviewArtifact,
  type PreviewBlocked,
  type PreviewBudget,
  type PreviewCacheCleared,
  type PreviewChunk,
  type PreviewFailedReason,
  type PreviewImage,
  type PreviewImageKind,
  type PreviewMissing,
  type PreviewMissingReason,
  type PreviewSettings,
  type PreviewStatus,
  type PreviewSubject,
  type PreviewUnsupportedReason,
  type ProjectId,
  type VersionInfo,
} from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import { resolveVersionRef, versionInfoOf } from './history.ts';
import { fitWithin, imageInfo, pngSize } from './image-info.ts';
import type {
  CapturedImage,
  GitOid,
  GitTreeEntry,
  PreviewFileSource,
  PreviewPorts,
  ProjectGit,
  RenderJob,
  ServedFile,
  StoredPreview,
} from './ports.ts';
import { readSmallBlob } from './restore.ts';
import { printable, sha256Hex } from './text.ts';

// Previews (M1 plan §2.3, §8; TECH_STACK §10): a version's entry page, or one
// of its PNG/JPEG files, rendered by the Preview Host into a PNG and a
// thumbnail. Core decides what is rendered and which files the page may read
// (only the version's own, through checked paths and budgets), queues and
// deduplicates renders, and keeps the rebuildable cache. The renderer port
// only runs the host. Nothing here writes to the folder or its repo, and a
// failed preview never touches a version.

export interface PreviewService {
  preview(
    projectId: ProjectId,
    ref: string,
    file?: string,
    priority?: 'interactive' | 'background',
  ): Promise<PreviewArtifact>;
  read(projectId: ProjectId, artifactId: string, image: PreviewImageKind, offset: number): Promise<PreviewChunk>;
  status(): PreviewStatus;
  clearCache(): Promise<PreviewCacheCleared>;
  // After a save or restore: renders the version in the background so its
  // thumbnail is ready. Failures are dropped (the version is unaffected).
  warm(projectId: ProjectId, ref: string): void;
  // At Engine start: removes PNGs no cache row names.
  sweep(): Promise<void>;
}

export interface PreviewOptions {
  // Tests shorten the artifact lifetime and the budgets.
  artifactTtlMs?: number;
  budget?: Partial<PreviewBudget>;
}

// Bumped whenever what a cache key covers changes meaning.
const CACHE_FORMAT = 1;
const MAX_ARTIFACTS = 10_000;
// Core's own limit on a render, beyond the host's job timeout: process
// start and capture.
const RENDER_GRACE_MS = 15_000;

function unsupported(reason: PreviewUnsupportedReason, message: string, details: Record<string, string> = {}) {
  return new DtError('PREVIEW_UNSUPPORTED', message, { reason, ...details });
}

export function previewFailed(reason: PreviewFailedReason, message: string): DtError {
  return new DtError('PREVIEW_FAILED', message, { reason }, RETRYABLE_PREVIEW_FAILURES.has(reason));
}

const isRegularFile = (e: GitTreeEntry) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755');

// What a version shows, resolved from its own tree.
interface Resolved {
  repo: ProjectGit;
  version: VersionInfo;
  tree: GitOid;
  subject: PreviewSubject;
  // The image's tree entry and bytes (image subjects), already read and
  // checked.
  image: { entry: GitTreeEntry; oid: GitOid; bytes: Uint8Array } | null;
}

export function previewSettings(timezone: string): PreviewSettings {
  return {
    viewport: { ...PREVIEW_VIEWPORT },
    thumbnail: { ...PREVIEW_THUMBNAIL },
    locale: PREVIEW_LOCALE,
    timezone,
    scripts: true,
    wait: PREVIEW_WAIT,
    animations: PREVIEW_ANIMATIONS,
  };
}

// Sizes the two PNGs must have. A page: the viewport and the thumbnail box.
// An image: its own size fitted (never enlarged) into the image box, and
// that fitted again into the thumbnail box.
export function outputSizes(subject: PreviewSubject, settings: PreviewSettings) {
  if (subject.kind === 'page') {
    return {
      output: { width: settings.viewport.width, height: settings.viewport.height },
      thumbnail: { ...settings.thumbnail },
    };
  }
  const output = fitWithin(subject, PREVIEW_IMAGE_BOX);
  return { output, thumbnail: fitWithin(output, settings.thumbnail) };
}

// ---- Serving files to a render

interface FileReport {
  missing: PreviewMissing;
  requests: number;
  servedBytes: number;
}

// A path a page asked for (the URL's pathname, percent-encoded) → the path in
// the version, or null when it isn't one.
export function decodePreviewPath(raw: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(raw.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  return isSafeRelativePath(path) ? path : null;
}

// The files of one version, as a page may read them: regular files of the
// tree, of a type previews serve, within the per-file and per-render budgets.
// Every refusal is recorded (missing resources, M1 plan §8). Lookups are by
// exact name; a name in the other Unicode normalization form is accepted too
// (macOS writes NFD, pages are usually NFC).
export function createFileSource(
  repo: Pick<ProjectGit, 'streamBlob'>,
  files: ReadonlyMap<string, GitTreeEntry>,
  budget: Pick<PreviewBudget, 'fileBytes' | 'totalBytes' | 'requests'>,
  // Bytes already in memory (an image subject), by blob id.
  preloaded?: { oid: GitOid; bytes: Uint8Array },
): PreviewFileSource & { report(): FileReport } {
  let requests = 0;
  let servedBytes = 0;
  let missingCount = 0;
  const samples: PreviewMissing['entries'] = [];
  const miss = (raw: string, reason: PreviewMissingReason): ServedFile => {
    missingCount++;
    if (samples.length < PREVIEW_SAMPLE_MAX) {
      let shown = raw;
      try {
        shown = decodeURIComponent(raw);
      } catch {
        // Shown as it came.
      }
      samples.push({ path: printable(shown.replace(/^\/+/, ''), PREVIEW_SAMPLE_CHARS), reason });
    }
    return { status: 'missing' };
  };
  const lookup = (path: string) =>
    files.get(path) ?? files.get(path.normalize('NFC')) ?? files.get(path.normalize('NFD'));

  return {
    async read(raw) {
      requests++;
      if (requests > budget.requests) return miss(raw, 'budget');
      const path = decodePreviewPath(raw);
      if (path === null) return miss(raw, 'invalid-path');
      const entry = lookup(path);
      if (!entry) return miss(raw, 'not-in-version');
      if (!isRegularFile(entry)) return miss(raw, 'not-a-file');
      const contentType = previewContentType(path);
      if (contentType === null) return miss(raw, 'type');
      if (entry.size !== null && entry.size > budget.fileBytes) return miss(raw, 'too-large');
      if (servedBytes + (entry.size ?? 0) > budget.totalBytes) return miss(raw, 'budget');
      const bytes =
        preloaded?.oid === entry.oid ? preloaded.bytes : await readSmallBlob(repo, entry.oid, budget.fileBytes);
      if (bytes === null) return miss(raw, 'too-large');
      if (servedBytes + bytes.byteLength > budget.totalBytes) return miss(raw, 'budget');
      servedBytes += bytes.byteLength;
      return { status: 'ok', contentType, bytes };
    },
    report: () => ({ missing: { count: missingCount, entries: samples }, requests, servedBytes }),
  };
}

function cleanBlocked(blocked: PreviewBlocked): PreviewBlocked {
  return {
    count: blocked.count,
    entries: blocked.entries
      .slice(0, PREVIEW_SAMPLE_MAX)
      .map((b) => ({ kind: b.kind, target: printable(b.target, PREVIEW_SAMPLE_CHARS) })),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- The service

interface Task {
  priority: 'interactive' | 'background';
  start: () => void;
}

interface Artifact {
  projectId: ProjectId;
  key: string;
  expiresAt: number;
}

export function createPreviewService(
  ctx: ProjectContext,
  ports: PreviewPorts | undefined,
  options: PreviewOptions = {},
): PreviewService {
  const { store, clock, requireProject, openBound, readableRepo, lineIndex } = ctx;
  const budget = { ...PREVIEW_BUDGET, ...options.budget };
  const ttlMs = options.artifactTtlMs ?? PREVIEW_ARTIFACT_TTL_MS;
  const settings = previewSettings(ports?.timezone ?? 'UTC');
  const rendererId = ports?.renderer.rendererId ?? null;

  // Renders run one at a time (one Preview Host), the app's before
  // background ones; identical renders share one run.
  const waiting: Task[] = [];
  let running = 0;
  const inFlight = new Map<string, Promise<StoredPreview>>();
  const artifacts = new Map<string, Artifact>();

  function pump(): void {
    while (running < 1 && waiting.length > 0) {
      const i = waiting.findIndex((t) => t.priority === 'interactive');
      const [task] = waiting.splice(i >= 0 ? i : 0, 1);
      if (!task) return;
      running++;
      task.start();
    }
  }

  function schedule<T>(priority: Task['priority'], fn: () => Promise<T>): Promise<T> {
    if (waiting.length >= budget.queue) {
      return Promise.reject(previewFailed('queue-full', 'too many previews are waiting; try again shortly'));
    }
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        priority,
        start: () => {
          fn()
            .then(resolve, reject)
            .finally(() => {
              running--;
              pump();
            });
        },
      });
      pump();
    });
  }

  // ---- what to render

  async function resolve(projectId: ProjectId, ref: string, file: string | undefined): Promise<Resolved> {
    const p = requireProject(projectId);
    const { repo } = await openBound(p);
    const probe = await readableRepo(repo);
    if (probe.tip === null) throw new DtError('SNAPSHOT_NOT_FOUND', 'the project has no versions yet', { ref });
    const index = await lineIndex(projectId, repo, probe.tip);
    const [commit] = await repo.readCommits([resolveVersionRef(index, ref)]);
    if (!commit) throw new DtError('GIT_FAILED', 'the version could not be read');
    const version = versionInfoOf(commit, index);

    let path: string;
    if (file !== undefined) {
      path = file;
      const entry = await repo.lookupPath(commit.tree, path);
      if (!entry) throw unsupported('file-missing', 'the file is not in this version', { path });
      if (!isRegularFile(entry)) throw unsupported('not-a-file', 'this is a link or submodule, not a file', { path });
      if (previewKindOf(path) !== 'image') {
        throw unsupported('file-type', 'only PNG and JPEG files have image previews', { path });
      }
      return { repo, version, tree: commit.tree, ...(await imageSubject(repo, path, entry)) };
    }

    const configEntry = await repo.lookupPath(commit.tree, PROJECT_CONFIG_FILE);
    if (!configEntry) throw unsupported('no-settings', `this version has no ${PROJECT_CONFIG_FILE}`);
    const configBytes = isRegularFile(configEntry)
      ? await readSmallBlob(repo, configEntry.oid, MAX_PROJECT_CONFIG_BYTES)
      : null;
    let entryFiles: string[];
    try {
      if (!configBytes) throw new Error('unreadable');
      entryFiles = parseProjectConfig(configBytes).entryFiles;
    } catch (e) {
      const given = e instanceof DtError ? e.details['reason'] : 'not-regular-file';
      const reason = typeof given === 'string' ? given : 'schema';
      throw unsupported('settings-invalid', `this version's ${PROJECT_CONFIG_FILE} can't be read`, {
        configReason: reason,
      });
    }
    const entryPath = entryFiles[0];
    if (entryPath === undefined) throw unsupported('no-entry', 'this version names no entry page');
    path = entryPath;
    const entry = await repo.lookupPath(commit.tree, path);
    if (!entry) throw unsupported('entry-missing', 'the entry page is not in this version', { path });
    if (!isRegularFile(entry)) throw unsupported('not-a-file', 'the entry is a link or submodule', { path });
    const kind = previewKindOf(path);
    if (kind === null) throw unsupported('entry-type', 'the entry is neither an HTML page nor a PNG/JPEG', { path });
    if (kind === 'image') return { repo, version, tree: commit.tree, ...(await imageSubject(repo, path, entry)) };
    return { repo, version, tree: commit.tree, subject: { kind: 'page', path }, image: null };
  }

  async function imageSubject(
    repo: ProjectGit,
    path: string,
    entry: GitTreeEntry,
  ): Promise<Pick<Resolved, 'subject' | 'image'>> {
    if (entry.size !== null && entry.size > budget.fileBytes) {
      throw unsupported('image-too-large', 'the image is larger than previews decode', { path });
    }
    const bytes = await readSmallBlob(repo, entry.oid, budget.fileBytes);
    if (!bytes) throw unsupported('image-too-large', 'the image is larger than previews decode', { path });
    const info = imageInfo(bytes);
    if (!info) throw unsupported('image-invalid', 'the file is not a PNG or JPEG Draft Tide can read', { path });
    if (info.width * info.height > budget.imagePixels) {
      throw unsupported('image-too-large', 'the image has more pixels than previews decode', { path });
    }
    return {
      subject: { kind: 'image', path, width: info.width, height: info.height },
      image: { entry, oid: entry.oid, bytes },
    };
  }

  // Covers everything the picture depends on: the whole tree for a page (any
  // file may be one it loads), the blob for an image, the settings and the
  // renderer. Equal trees (a restore of an older version) share previews.
  async function cacheKey(r: Resolved): Promise<string> {
    const what =
      r.subject.kind === 'page'
        ? { kind: 'page', tree: r.tree, path: r.subject.path }
        : { kind: 'image', blob: r.image?.oid ?? null };
    return sha256Hex(canonicalJson({ format: CACHE_FORMAT, renderer: rendererId, settings, what }));
  }

  // ---- rendering and the cache

  async function checkedImage(image: CapturedImage, want: { width: number; height: number }): Promise<PreviewImage> {
    const size = pngSize(image.png);
    if (!size || size.width !== want.width || size.height !== want.height) {
      throw previewFailed('invalid-output', "the Preview Host's image doesn't have the expected size");
    }
    return {
      width: size.width,
      height: size.height,
      bytes: image.png.byteLength,
      sha256: await sha256Bytes(image.png),
    };
  }

  async function render(projectId: ProjectId, key: string, r: Resolved): Promise<StoredPreview> {
    if (!ports || rendererId === null) {
      throw previewFailed('no-renderer', 'this Draft Tide Engine has no Preview Host');
    }
    // A page may read any file of its version; an image job only the image.
    const files =
      r.subject.kind === 'page'
        ? new Map((await r.repo.listTree(r.tree)).entries.map((e) => [e.path, e]))
        : new Map(r.image ? [[r.subject.path, r.image.entry]] : []);
    const source = createFileSource(r.repo, files, budget, r.image ?? undefined);
    const sizes = outputSizes(r.subject, settings);
    const job: RenderJob = {
      jobId: crypto.randomUUID(),
      projectId,
      subject: r.subject,
      settings,
      ...sizes,
      timeoutMs: budget.timeoutMs,
    };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(previewFailed('timeout', 'the preview took too long')),
      budget.timeoutMs + RENDER_GRACE_MS,
    );
    let out;
    try {
      out = await ports.renderer.render(job, source, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const [image, thumbnail] = await Promise.all([
      checkedImage(out.full, sizes.output),
      checkedImage(out.thumbnail, sizes.thumbnail),
    ]);
    const now = clock.nowIso();
    const record = PreviewRecord.parse({
      subject: r.subject,
      image,
      thumbnail,
      renderedAt: now,
      missing: source.report().missing,
      blocked: cleanBlocked(out.blocked),
      settings,
      environment: out.environment,
    });
    await ports.images.write(projectId, key, 'full', out.full.png);
    await ports.images.write(projectId, key, 'thumbnail', out.thumbnail.png);
    const stored: StoredPreview = {
      projectId,
      key,
      createdAt: now,
      usedAt: now,
      bytes: image.bytes + thumbnail.bytes,
      record,
    };
    store.putPreview(stored);
    await evict(projectId, key);
    return stored;
  }

  // Least recently used first, until the cache fits its budget; the preview
  // just made always stays.
  async function evict(keepProject: ProjectId, keepKey: string): Promise<void> {
    if (!ports) return;
    const all = store.listPreviews();
    let total = all.reduce((n, e) => n + e.bytes, 0);
    for (const e of all) {
      if (total <= budget.cacheBytes) break;
      if (e.projectId === keepProject && e.key === keepKey) continue;
      store.deletePreview(e.projectId, e.key);
      await ports.images.remove(e.projectId, e.key);
      total -= e.bytes;
    }
  }

  async function cached(projectId: ProjectId, key: string): Promise<StoredPreview | null> {
    const hit = store.getPreview(projectId, key);
    if (!hit) return null;
    if (ports && (await ports.images.has(projectId, key))) return hit;
    store.deletePreview(projectId, key);
    return null;
  }

  function mint(projectId: ProjectId, key: string): { artifactId: ArtifactId; expiresAt: IsoTimestamp } {
    const now = Date.now();
    for (const [id, a] of artifacts) {
      if (a.expiresAt <= now || artifacts.size >= MAX_ARTIFACTS) artifacts.delete(id);
      else break;
    }
    const artifactId = ArtifactId.parse(crypto.randomUUID());
    const expiresAt = now + ttlMs;
    artifacts.set(artifactId, { projectId, key, expiresAt });
    return { artifactId, expiresAt: new Date(expiresAt).toISOString() };
  }

  async function preview(
    projectId: ProjectId,
    ref: string,
    file?: string,
    priority: 'interactive' | 'background' = 'interactive',
  ): Promise<PreviewArtifact> {
    const r = await resolve(projectId, ref, file);
    const key = await cacheKey(r);
    let stored = await cached(projectId, key);
    const fromCache = stored !== null;
    if (stored) {
      store.touchPreview(projectId, key, clock.nowIso());
    } else {
      const flightKey = `${projectId}/${key}`;
      let flight = inFlight.get(flightKey);
      if (!flight) {
        flight = schedule(priority, () => render(projectId, key, r)).finally(() => inFlight.delete(flightKey));
        inFlight.set(flightKey, flight);
      }
      stored = await flight;
    }
    const rec = stored.record;
    const missing = rec.missing;
    const blocked = rec.blocked;
    return {
      ...mint(projectId, key),
      projectId,
      version: r.version,
      // The path asked for now (an image's blob may be cached from another
      // path); everything else as rendered.
      subject: r.subject,
      image: rec.image,
      thumbnail: rec.thumbnail,
      renderedAt: rec.renderedAt,
      cached: fromCache,
      missing,
      blocked,
      incomplete: missing.count > 0 || blocked.count > 0,
      settings: rec.settings,
      environment: rec.environment,
    };
  }

  async function read(
    projectId: ProjectId,
    artifactId: string,
    image: PreviewImageKind,
    offset: number,
  ): Promise<PreviewChunk> {
    requireProject(projectId);
    const a = artifacts.get(artifactId);
    if (!a) {
      throw new DtError('INVALID_ARGUMENT', 'no preview artifact has this id; ask for the preview again', {
        reason: 'unknown-artifact',
      });
    }
    if (a.projectId !== projectId) {
      throw new DtError('INVALID_ARGUMENT', 'this preview artifact belongs to another project', {
        reason: 'artifact-of-another-project',
      });
    }
    const expired = () =>
      new DtError('INVALID_ARGUMENT', 'this preview artifact has expired; ask for the preview again', {
        reason: 'artifact-expired',
      });
    if (a.expiresAt <= Date.now()) {
      artifacts.delete(artifactId);
      throw expired();
    }
    const stored = store.getPreview(projectId, a.key);
    if (!stored || !ports) throw expired();
    const size = image === 'full' ? stored.record.image.bytes : stored.record.thumbnail.bytes;
    if (offset > size) {
      throw new DtError('INVALID_ARGUMENT', 'offset is past the end of the image', { reason: 'offset', size });
    }
    const bytes = await ports.images.read(projectId, a.key, image, offset, PREVIEW_READ_CHUNK_BYTES);
    if (bytes === null) throw expired();
    return {
      artifactId: ArtifactId.parse(artifactId),
      image,
      offset,
      size,
      data: toBase64(bytes),
      done: offset + bytes.byteLength >= size,
    };
  }

  return {
    preview,
    read,
    status() {
      const all = store.listPreviews();
      return {
        available: rendererId !== null,
        renderer: rendererId,
        settings,
        queue: { waiting: waiting.length, running },
        cache: {
          entries: all.length,
          bytes: all.reduce((n, e) => n + e.bytes, 0),
          budgetBytes: budget.cacheBytes,
        },
      };
    },
    async clearCache() {
      const all = store.listPreviews();
      for (const e of all) store.deletePreview(e.projectId, e.key);
      await ports?.images.removeAllExcept(new Set());
      artifacts.clear();
      return { entries: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
    },
    warm(projectId, ref) {
      if (rendererId === null) return;
      preview(projectId, ref, undefined, 'background').catch(() => undefined);
    },
    async sweep() {
      if (!ports) return;
      await ports.images.removeAllExcept(new Set(store.listPreviews().map((e) => `${e.projectId}/${e.key}`)));
    },
  };
}
