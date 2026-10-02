import { useQuery, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { DtError, type PreviewArtifact, type PreviewImageKind, type ProjectId } from '@draft-tide/contracts';
import { engineCall } from './bridge.ts';

// Previews in the app (M1 plan §8). A preview is asked for by version (and
// file, for an image); the Engine answers with a short-lived artifact whose
// PNGs are read in chunks and shown from blob URLs. The bytes are checked
// against the artifact's hash before they are shown. Previews never decide
// anything: they are pictures next to the versions.

// Each preview call waits for a render and holds one of the desktop
// connection's request slots, so only a few wait at once.
const MAX_CALLS = 3;
let calls = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (calls >= MAX_CALLS) await new Promise<void>((resolve) => waiting.push(resolve));
  calls++;
  try {
    return await fn();
  } finally {
    calls--;
    waiting.shift()?.();
  }
}

export const previewKey = (projectId: string, ref: string, file?: string) =>
  ['snapshot.preview', projectId, ref, file ?? ''] as const;

function fetchPreview(projectId: ProjectId, ref: string, file?: string): Promise<PreviewArtifact> {
  return limited(() =>
    engineCall('snapshot.preview', { projectId, version: ref, ...(file !== undefined ? { file } : {}) }),
  );
}

// Artifacts can be read for 30 minutes; the app asks again before that.
const ARTIFACT_STALE_MS = 20 * 60 * 1000;

export function usePreview(projectId: ProjectId, ref: string, options: { file?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: previewKey(projectId, ref, options.file),
    queryFn: () => fetchPreview(projectId, ref, options.file),
    enabled: options.enabled ?? true,
    staleTime: ARTIFACT_STALE_MS,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// ---- The PNGs

// Each PNG becomes a blob URL held by its query (keyed by the PNG's hash, so
// the same picture is read once). The URL is released when the query is
// dropped from the cache or its data is replaced, never while it is shown.
export function releasePreviewUrls(client: QueryClient): () => void {
  const held = new Map<string, string>();
  return client.getQueryCache().subscribe((event) => {
    const query = event.query as Query;
    if (query.queryKey[0] !== 'preview.image') return;
    const current = typeof query.state.data === 'string' ? query.state.data : undefined;
    const previous = held.get(query.queryHash);
    if (event.type === 'removed') {
      if (previous) URL.revokeObjectURL(previous);
      held.delete(query.queryHash);
    } else if (current !== previous) {
      if (previous) URL.revokeObjectURL(previous);
      if (current) held.set(query.queryHash, current);
      else held.delete(query.queryHash);
    }
  });
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readPng(art: PreviewArtifact, image: PreviewImageKind): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await engineCall('preview.read', {
      projectId: art.projectId,
      artifactId: art.artifactId,
      image,
      offset,
    });
    const bytes = fromBase64(chunk.data);
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done || bytes.length === 0) break;
  }
  const all = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const want = image === 'full' ? art.image.sha256 : art.thumbnail.sha256;
  if ((await sha256(all)) !== want) {
    throw new DtError('PREVIEW_FAILED', 'the preview changed while it was read', { reason: 'invalid-output' });
  }
  return new Blob([all], { type: 'image/png' });
}

function expired(e: unknown): boolean {
  const reason = e instanceof DtError ? e.details['reason'] : null;
  return (
    e instanceof DtError &&
    e.code === 'INVALID_ARGUMENT' &&
    (reason === 'artifact-expired' || reason === 'unknown-artifact')
  );
}

async function renew(client: QueryClient, art: PreviewArtifact, ref: string, file?: string) {
  return client.fetchQuery({
    queryKey: previewKey(art.projectId, ref, file),
    queryFn: () => fetchPreview(art.projectId, ref, file),
    staleTime: 0,
  });
}

// A blob URL for one of the artifact's PNGs. An artifact that expired (or an
// Engine that restarted) is asked for again once.
export function usePreviewImage(
  art: PreviewArtifact | undefined,
  image: PreviewImageKind,
  source: { ref: string; file?: string },
) {
  const client = useQueryClient();
  const sha = art ? (image === 'full' ? art.image.sha256 : art.thumbnail.sha256) : '';
  return useQuery({
    queryKey: ['preview.image', sha, image] as const,
    enabled: art !== undefined,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      if (!art) throw new Error('no artifact');
      let blob: Blob;
      try {
        blob = await readPng(art, image);
      } catch (e) {
        if (!expired(e)) throw e;
        blob = await readPng(await renew(client, art, source.ref, source.file), image);
      }
      return URL.createObjectURL(blob);
    },
  });
}

// ---- Engine-wide

export const previewStatusKey = ['preview.status'] as const;

export function usePreviewStatus() {
  return useQuery({ queryKey: previewStatusKey, queryFn: () => engineCall('preview.status', {}) });
}

// True once the element has been on screen (history rows render their
// thumbnails only then).
export function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}
