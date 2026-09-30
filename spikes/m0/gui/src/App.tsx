import { AppHeader } from './components/AppHeader';
import { GuidePanel, currentProject } from './components/GuidePanel';
import { Toasts } from './components/Toasts';
import { BackupDialog } from './screens/BackupDialog';
import { CompareScreen } from './screens/CompareScreen';
import { ProjectHome } from './screens/ProjectHome';
import { RestoreScreen } from './screens/RestoreScreen';
import { ScopeReview } from './screens/ScopeReview';
import { SettingsScreen } from './screens/SettingsScreen';
import { StartScreen } from './screens/StartScreen';
import { StoreProvider, useStore } from './state/store';

function Screen() {
  const { state } = useStore();
  const r = state.route;
  switch (r.name) {
    case 'start':
      return <StartScreen />;
    case 'scope':
      return <ScopeReview />;
    case 'project':
      return <ProjectHome key={r.projectId} projectId={r.projectId} {...(r.focus ? { focus: r.focus } : {})} />;
    case 'compare':
      return <CompareScreen projectId={r.projectId} leftId={r.leftId} rightId={r.rightId} />;
    case 'restore':
      return (
        <RestoreScreen
          key={`${r.projectId}:${r.targetId}`}
          projectId={r.projectId}
          targetId={r.targetId}
          {...(r.requestId ? { requestId: r.requestId } : {})}
        />
      );
    case 'settings':
      return <SettingsScreen {...(r.projectId ? { projectId: r.projectId } : {})} />;
  }
}

function Shell() {
  const { state } = useStore();
  const backupProject = state.backupOpen ? currentProject(state) : undefined;
  return (
    <div className="flex h-full flex-col">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        {state.guideOpen && <GuidePanel />}
        <main className="min-w-0 flex-1">
          <Screen />
        </main>
      </div>
      {!state.guideOpen && <GuidePanel />}
      {backupProject && <BackupDialog project={backupProject} />}
      <Toasts />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
