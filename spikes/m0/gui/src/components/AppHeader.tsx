import { useStore } from '../state/store';
import { Archive, ChevronRight, Compass, Gear, TideMark } from './Icons';
import { Button } from './ui/Button';

export function AppHeader() {
  const { state, navigate, dispatch } = useStore();
  const route = state.route;
  const projectId = 'projectId' in route ? route.projectId : undefined;
  const project = projectId ? state.projects.find((p) => p.id === projectId) : undefined;

  return (
    <header className="flex h-header shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
      <button
        type="button"
        onClick={() => navigate({ name: 'start' })}
        className="flex items-center gap-2 rounded-md py-1 pr-2 text-[15px] font-semibold tracking-tight text-ink"
        aria-label="Draft Tide 首頁：專案列表"
      >
        <TideMark />
        Draft Tide
      </button>
      {project && (
        <>
          <ChevronRight className="size-4 text-ink-3" />
          <button
            type="button"
            onClick={() => navigate({ name: 'project', projectId: project.id })}
            className="min-w-0 truncate rounded-md px-1 text-sm font-medium text-ink hover:text-tide-700"
          >
            {project.name}
          </button>
          <span className="hidden truncate text-[12px] text-ink-3 lg:inline">{project.displayPath}</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={state.guideOpen}
          onClick={() => dispatch({ type: 'guideOpen', open: !state.guideOpen })}
        >
          <Compass />
          導覽
        </Button>
        {project && (
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'backupOpen', open: true })}>
            <Archive />
            備份
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-current={route.name === 'settings' ? 'page' : undefined}
          onClick={() => navigate(projectId ? { name: 'settings', projectId } : { name: 'settings' })}
        >
          <Gear />
          設定與診斷
        </Button>
      </div>
    </header>
  );
}
