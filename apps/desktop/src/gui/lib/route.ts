import type { ErrorInfo, ProjectId } from '@draft-tide/contracts';

// The GUI's screens. State only: there is no URL routing in the app window.
export type Route =
  | { name: 'home' }
  | { name: 'review'; root: string }
  // notice: why the first version wasn't saved right after connecting.
  | { name: 'project'; projectId: ProjectId; notice?: ErrorInfo }
  | { name: 'compare'; projectId: ProjectId; from: string; to: string }
  | { name: 'account' }
  | { name: 'settings' };

export type Navigate = (route: Route) => void;
