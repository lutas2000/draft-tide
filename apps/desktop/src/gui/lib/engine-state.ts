import {
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
} from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EngineEvent, OperationId, PlanId, ProjectId, RecoveryStrategy } from '@draft-tide/contracts';
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
  operations: ['operation.list'] as const,
  restorePlan: (projectId: string, target: string) => ['restore.plan', projectId, target] as const,
  recovery: (projectId: string) => ['recovery.inspect', projectId] as const,
};

// Everything a change to a project can move: its folder state, history,
// what needs recovery, and the app-wide operation list.
function invalidateProject(client: QueryClient, projectId: string): void {
  void client.invalidateQueries({ queryKey: keys.status(projectId) });
  void client.invalidateQueries({ queryKey: keys.history(projectId) });
  void client.invalidateQueries({ queryKey: keys.recovery(projectId) });
  void client.invalidateQueries({ queryKey: keys.operations });
}

// A restore plan is never re-read behind the user's back: each read makes a
// new plan, and the one on screen is the one confirmed.
const rereadable = (query: Query) => query.queryKey[0] !== 'restore.plan';

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
      // The agent request this answers.
      requestId?: OperationId;
    }) => engineCall('project.bind', input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.projects });
      void client.invalidateQueries({ queryKey: keys.operations });
    },
  });
}

// Puts `.drafttide.json` back from the newest version, only while it is
// missing from the folder.
export function useRestoreSettings(projectId: ProjectId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => engineCall('project.restoreSettings', { projectId }),
    onSettled: () => invalidateProject(client, projectId),
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

// ---- Restore and recovery (M1 plan §9.2–9.4). Nothing here is optimistic:
// a restore shows as done only when the Engine's answer says so.

// Read once per dialog: the plan is what the user confirms (see rereadable).
export function useRestorePlan(projectId: ProjectId, target: string) {
  return useQuery({
    queryKey: keys.restorePlan(projectId, target),
    queryFn: () => engineCall('restore.plan', { projectId, target }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useRestoreApply(projectId: ProjectId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planId: PlanId) => engineCall('restore.apply', { projectId, planId }),
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useRecoveryReport(projectId: ProjectId, enabled: boolean) {
  return useQuery({
    queryKey: keys.recovery(projectId),
    queryFn: () => engineCall('recovery.inspect', { projectId }),
    enabled,
    staleTime: 1_000,
  });
}

export function useRecoveryPlan(projectId: ProjectId) {
  return useMutation({
    mutationFn: (input: { operationId: OperationId; strategy: RecoveryStrategy }) =>
      engineCall('recovery.plan', { projectId, ...input }),
  });
}

export function useRecoveryApply(projectId: ProjectId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planId: PlanId) => engineCall('recovery.apply', { projectId, planId }),
    onSettled: () => invalidateProject(client, projectId),
  });
}

// Asks a running operation to stop at its next safe boundary. The answer may
// be too-late: then it finishes, and its own result says how.
export function useCancelOperation() {
  return useMutation({
    mutationFn: (operationId: OperationId) => engineCall('operation.cancel', { operationId }),
  });
}

// ---- Agent requests, agent restores and operations needing recovery, in
// every project (M1 plan §4.1, §9.1).

export function useOperationList() {
  return useQuery({ queryKey: keys.operations, queryFn: () => engineCall('operation.list', {}) });
}

export function useDeclineRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operationId: OperationId) => engineCall('request.decline', { operationId }),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.operations }),
  });
}

export function useDismissNotice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operationId: OperationId) => engineCall('operation.dismiss', { operationId }),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.operations }),
  });
}

// ---- Progress of running operations, per project, from Engine events: a
// save's, a restore's or a recovery's.

export type ProgressEvent = Extract<EngineEvent, { name: 'operation.progress' }>;
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
    // Missed events (a gap, a reconnect) may include an operation's end:
    // progress is dropped and everything shown is re-read.
    const rereadAll = () => {
      for (const id of [...progress.keys()]) setProgress(id, null);
      void client.invalidateQueries({ predicate: rereadable });
    };
    const offConnection = b.onConnection((s) => {
      setState(s);
      if (s.status === 'connected') rereadAll();
    });
    const offEvent = b.onEvent(({ event, gap }) => {
      if (gap) return rereadAll();
      if (event.name === 'agentAccess.changed') {
        client.setQueryData(keys.agentAccess, event.agentAccess);
        void client.invalidateQueries({ queryKey: keys.engineInfo });
      } else if (event.name === 'project.changed') {
        void client.invalidateQueries({ queryKey: keys.projects });
        void client.invalidateQueries({ queryKey: keys.status(event.projectId) });
        void client.invalidateQueries({ queryKey: keys.history(event.projectId) });
        void client.invalidateQueries({ queryKey: keys.operations });
        if (event.reason === 'restored' || event.reason === 'recovered') {
          void client.invalidateQueries({ queryKey: keys.recovery(event.projectId) });
        }
      } else if (event.name === 'operation.progress') {
        setProgress(event.projectId, event);
      } else if (event.name === 'operation.settled') {
        if (progress.get(event.projectId)?.operationId === event.operationId) setProgress(event.projectId, null);
        void client.invalidateQueries({ queryKey: keys.status(event.projectId) });
        if (event.outcome === 'recovery-required') {
          void client.invalidateQueries({ queryKey: keys.recovery(event.projectId) });
        }
      } else if (event.name === 'operations.changed') {
        void client.invalidateQueries({ queryKey: keys.operations });
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
