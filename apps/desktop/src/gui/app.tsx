import { useState } from 'react';
import { AppShell, type Screen } from './components/app-shell.tsx';
import { useEngineConnection } from './lib/engine-state.ts';
import { AccountScreen } from './screens/account.tsx';
import { ProjectsScreen } from './screens/projects.tsx';
import { SettingsScreen } from './screens/settings.tsx';

export function App() {
  const [screen, setScreen] = useState<Screen>('projects');
  const { state, retry } = useEngineConnection();

  return (
    <AppShell screen={screen} onNavigate={setScreen} connection={state} onRetry={retry}>
      {screen === 'projects' && <ProjectsScreen />}
      {screen === 'account' && <AccountScreen />}
      {screen === 'settings' && <SettingsScreen connection={state} />}
    </AppShell>
  );
}
