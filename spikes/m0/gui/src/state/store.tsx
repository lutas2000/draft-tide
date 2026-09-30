import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { uuid } from '../lib/hash';
import { seedPending, seedProjects } from '../mock/data';
import type { PendingApproval, Project, ProjectId, ScopeDraft, SnapshotId } from '../mock/types';

// ---------------------------------------------------------------------------
// Routes (screen state lives in React; no router needed for the prototype)

export type Route =
  | { name: 'start' }
  | { name: 'scope' }
  | { name: 'project'; projectId: ProjectId; focus?: SnapshotId }
  | { name: 'compare'; projectId: ProjectId; leftId: SnapshotId; rightId: SnapshotId }
  | { name: 'restore'; projectId: ProjectId; targetId: SnapshotId; requestId?: string }
  | { name: 'settings'; projectId?: ProjectId };

export interface Toast {
  id: string;
  tone: 'info' | 'ok' | 'warn';
  title: string;
  body?: string;
}

export interface AppState {
  route: Route;
  projects: Project[];
  scopeDraft: ScopeDraft | null;
  pending: PendingApproval[];
  toasts: Toast[];
  guideOpen: boolean;
  guideDone: number[];
  backupOpen: boolean;
  cacheBytes: number;
}

export type Action =
  | { type: 'navigate'; route: Route }
  | { type: 'setScopeDraft'; draft: ScopeDraft | null }
  | { type: 'addProject'; project: Project }
  | { type: 'updateProject'; id: ProjectId; update: (p: Project) => Project }
  | { type: 'removePending'; id: string }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismissToast'; id: string }
  | { type: 'guideOpen'; open: boolean }
  | { type: 'guideDone'; step: number }
  | { type: 'backupOpen'; open: boolean }
  | { type: 'clearCache' }
  | { type: 'reset' };

function initialState(): AppState {
  return {
    route: { name: 'start' },
    projects: seedProjects(),
    scopeDraft: null,
    pending: seedPending(),
    toasts: [],
    guideOpen: true,
    guideDone: [],
    backupOpen: false,
    cacheBytes: 48_300_000,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'navigate': {
      let projects = state.projects;
      const pid = 'projectId' in action.route ? action.route.projectId : undefined;
      if (pid) {
        // Most recently opened first.
        const found = projects.find((p) => p.id === pid);
        if (found) {
          projects = [{ ...found, lastOpenedAt: new Date().toISOString() }, ...projects.filter((p) => p.id !== pid)];
        }
      }
      return { ...state, route: action.route, projects };
    }
    case 'setScopeDraft':
      return { ...state, scopeDraft: action.draft };
    case 'addProject':
      return { ...state, projects: [action.project, ...state.projects.filter((p) => p.id !== action.project.id)] };
    case 'updateProject':
      return { ...state, projects: state.projects.map((p) => (p.id === action.id ? action.update(p) : p)) };
    case 'removePending':
      return { ...state, pending: state.pending.filter((p) => p.id !== action.id) };
    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-2), action.toast] };
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'guideOpen':
      return { ...state, guideOpen: action.open };
    case 'guideDone':
      return state.guideDone.includes(action.step) ? state : { ...state, guideDone: [...state.guideDone, action.step] };
    case 'backupOpen':
      return { ...state, backupOpen: action.open };
    case 'clearCache':
      return { ...state, cacheBytes: 0 };
    case 'reset':
      return { ...initialState(), guideOpen: state.guideOpen };
  }
}

// ---------------------------------------------------------------------------

interface StoreValue {
  state: AppState;
  dispatch: (a: Action) => void;
  /** Reads the latest committed state (for async simulated operations). */
  getState: () => AppState;
  getProject: (id: ProjectId) => Project;
  navigate: (route: Route) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  markStep: (step: number) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const ref = useRef(state);
  ref.current = state;

  const getState = useCallback(() => ref.current, []);
  const getProject = useCallback((id: ProjectId) => {
    const p = ref.current.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }, []);
  const navigate = useCallback((route: Route) => dispatch({ type: 'navigate', route }), []);
  const toast = useCallback((t: Omit<Toast, 'id'>) => dispatch({ type: 'toast', toast: { ...t, id: uuid() } }), []);
  const markStep = useCallback((step: number) => dispatch({ type: 'guideDone', step }), []);

  // Keep the ref fresh even between renders triggered elsewhere.
  useEffect(() => {
    ref.current = state;
  }, [state]);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, getState, getProject, navigate, toast, markStep }),
    [state, getState, getProject, navigate, toast, markStep],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

export function useProject(id: ProjectId): Project | undefined {
  const { state } = useStore();
  return state.projects.find((p) => p.id === id);
}
