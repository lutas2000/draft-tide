import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ConnectionState } from '../../shared/bridge.ts';
import { bridge, engineCall } from './bridge.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

const keys = {
  engineInfo: ['engine.info'] as const,
  projects: ['project.list'] as const,
  agentAccess: ['agentAccess.get'] as const,
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
      if (gap) return void client.invalidateQueries();
      if (event.name === 'agentAccess.changed') {
        client.setQueryData(keys.agentAccess, event.agentAccess);
        void client.invalidateQueries({ queryKey: keys.engineInfo });
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
