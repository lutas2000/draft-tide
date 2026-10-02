import { useState } from 'react';
import { AppShell } from './components/app-shell.tsx';
import { useEngineConnection } from './lib/engine-state.ts';
import type { Route } from './lib/route.ts';
import { AccountScreen } from './screens/account.tsx';
import { CompareScreen } from './screens/compare.tsx';
import { ProjectScreen } from './screens/project.tsx';
import { ProjectsScreen } from './screens/projects.tsx';
import { ReviewScreen } from './screens/review.tsx';
import { SettingsScreen } from './screens/settings.tsx';

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const { state, retry } = useEngineConnection();

  return (
    <AppShell route={route} onNavigate={setRoute} connection={state} onRetry={retry}>
      {route.name === 'home' && <ProjectsScreen navigate={setRoute} />}
      {route.name === 'review' && (
        <ReviewScreen
          key={`${route.root}\n${route.requestId ?? ''}`}
          root={route.root}
          navigate={setRoute}
          {...(route.requestId ? { requestId: route.requestId } : {})}
        />
      )}
      {route.name === 'project' && (
        <ProjectScreen
          key={`${route.projectId}\n${route.connectRequestId ?? ''}`}
          projectId={route.projectId}
          navigate={setRoute}
          {...(route.notice ? { notice: route.notice } : {})}
          {...(route.connectRequestId ? { connectRequestId: route.connectRequestId } : {})}
        />
      )}
      {route.name === 'compare' && (
        <CompareScreen projectId={route.projectId} from={route.from} to={route.to} navigate={setRoute} />
      )}
      {route.name === 'account' && <AccountScreen navigate={setRoute} />}
      {route.name === 'settings' && <SettingsScreen connection={state} navigate={setRoute} />}
    </AppShell>
  );
}
