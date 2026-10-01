import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EngineEvent, ProjectId } from '@draft-tide/contracts';
import type { ConnectionState } from '../../shared/bridge.ts';
import { bridge, engineCall } from './bridge.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

export const keys = {
  engineInfo: ['engine.info'] as const,
  projects: ['project.list'] as const,
  agentAccess: ['agentAccess.get'] as const,
  review: (root: string) => ['project.review', root] as const,
  status: (projectId: string) => ['project.status', projectId] as const,
  history: (projectId: string) => ['history.list', projectId] as const,
  diff: (projectId: string, from: string, to: string) => ['snapshot.diff', projectId, from, to] as const,
  fileDiff: (projectId: string, from: string, to: string, path: string) =>
    ['snapshot.diffFile', projectId, from, to, path] as const,
};

export function useEngineInfo() {
  return useQuery({ queryKey: keys.engineInfo, queryFn: () => engineCall('engine.info', {}) });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => engineCall('project.list', {}) });
}

export function useAgentAccess() {
  return useQuery({ queryKey: keys.agentAccess, queryFn: () => engineCall('agentAccess.get', {}) });
}

// The switch flips only when the Engine says it did: no optimistic update.
export function useSetAgentAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => engineCall('agentAccess.set', { enabled }),
    onSuccess: (access) => {
      client.setQueryData(keys.agentAccess, access);
      void client.invalidateQueries({ queryKey: keys.engineInfo });
    },
  });
}

// A review is a snapshot of the folder at one moment: never refreshed behind
// the user's back, re-run on request.
export function useReview(root: string) {
  return useQuery({
    queryKey: keys.review(root),
    queryFn: () => engineCall('project.review', { root }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useBind() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      root: string;
      name: string;
      entryFiles: string[];
      reviewToken: string;
      asNewProject?: boolean;
    }) => engineCall('project.bind', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.projects }),
  });
}

// Status hashes the folder (cached by file identity in the Engine), so it is
// re-read when the window regains focus: the designer edits elsewhere.
export function useProjectStatus(projectId: ProjectId) {
  return useQuery({
    queryKey: keys.status(projectId),
    queryFn: () => engineCall('project.status', { projectId }),
    staleTime: 1_000,
  });
}

const HISTORY_PAGE = 100;

export function useHistory(projectId: ProjectId) {
  return useInfiniteQuery({
    queryKey: keys.history(projectId),
    queryFn: ({ pageParam }) => engineCall('history.list', { projectId, skip: pageParam, limit: HISTORY_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextSkip ?? undefined,
  });
}

export function useSave(projectId: ProjectId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string | undefined) =>
      engineCall('snapshot.create', { projectId, ...(name !== undefined && name.trim() ? { name } : {}) }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.status(projectId) });
      void client.invalidateQueries({ queryKey: keys.history(projectId) });
    },
  });
}

// Versions never change, so a comparison of two of them never goes stale.
export function useDiff(projectId: ProjectId, from: string, to: string) {
  return useQuery({
    queryKey: keys.diff(projectId, from, to),
    queryFn: () => engineCall('snapshot.diff', { projectId, from, to }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: from !== to,
  });
}

export function useFileDiff(projectId: ProjectId, from: string, to: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.fileDiff(projectId, from, to, path),
    queryFn: () => engineCall('snapshot.diffFile', { projectId, from, to, path }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
  });
}

// ---- Progress of running operations, per project, from Engine events.

type ProgressEvent = Extract<EngineEvent, { name: 'operation.progress' }>;
const progress = new Map<string, ProgressEvent>();
const progressListeners = new Set<() => void>();

function setProgress(projectId: string, event: ProgressEvent | null): void {
  if (event) progress.set(projectId, event);
  else progress.delete(projectId);
  for (const l of progressListeners) l();
}

export function useOperationProgress(projectId: string): ProgressEvent | null {
  return useSyncExternalStore(
    (listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    () => progress.get(projectId) ?? null,
  );
}

// Engine connection state from Main, plus event-driven invalidation: an event
// (or a gap in them, or a reconnect) means "re-read", never "it's done".
export function useEngineConnection(): { state: ConnectionState; retry: () => void } {
  const client = useQueryClient();
  const b = bridge();
  const [state, setState] = useState<ConnectionState>(
    b ? { status: 'connecting' } : { status: 'unavailable', message: 'not running inside the Draft Tide app' },
  );

  useEffect(() => {
    if (!b) return;
    let alive = true;
    void b.connectionState().then((s) => {
      if (alive && s) setState(s);
    });
    const offConnection = b.onConnection((s) => {
      setState(s);
      if (s.status === 'connected') void client.invalidateQueries();
    });
    const offEvent = b.onEvent(({ event, gap }) => {
      if (gap) {
        for (const id of [...progress.keys()]) setProgress(id, null);
        return void client.invalidateQueries();
      }
      if (event.name === 'agentAccess.changed') {
        client.setQueryData(keys.agentAccess, event.agentAccess);
        void client.invalidateQueries({ queryKey: keys.engineInfo });
      } else if (event.name === 'project.changed') {
        void client.invalidateQueries({ queryKey: keys.projects });
        void client.invalidateQueries({ queryKey: keys.status(event.projectId) });
        void client.invalidateQueries({ queryKey: keys.history(event.projectId) });
      } else if (event.name === 'operation.progress') {
        setProgress(event.projectId, event);
      } else if (event.name === 'operation.settled') {
        if (progress.get(event.projectId)?.operationId === event.operationId) setProgress(event.projectId, null);
        void client.invalidateQueries({ queryKey: keys.status(event.projectId) });
      }
    });
    return () => {
      alive = false;
      offConnection();
      offEvent();
    };
  }, [b, client]);

  return {
    state,
    retry: () => {
      if (!b) return;
      setState({ status: 'connecting' });
      void b.reconnect().then((s) => s && setState(s));
    },
  };
}
