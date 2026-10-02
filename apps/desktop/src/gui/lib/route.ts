import type { ErrorInfo, OperationId, ProjectId } from '@draft-tide/contracts';

// The GUI's screens. State only: there is no URL routing in the app window.
export type Route =
  | { name: 'home' }
  // requestId: the agent request (connect-request) that connecting answers.
  | { name: 'review'; root: string; requestId?: OperationId }
  // notice: why the first version wasn't saved right after connecting.
  // connectRequestId: an agent asked the user to connect this project to a
  // GitHub repository; the wizard opens.
  | { name: 'project'; projectId: ProjectId; notice?: ErrorInfo; connectRequestId?: OperationId }
  | { name: 'compare'; projectId: ProjectId; from: string; to: string }
  | { name: 'account' }
  | { name: 'settings' };

export type Navigate = (route: Route) => void;
