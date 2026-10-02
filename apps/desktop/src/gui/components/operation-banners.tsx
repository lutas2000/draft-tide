import { useState } from 'react';
import { DtError, type OperationStatus, type ProjectId } from '@draft-tide/contracts';
import { chooseFolder } from '../lib/bridge.ts';
import { ORIGIN_LABEL, errorCopy } from '../lib/copy.ts';
import { useDeclineRequest, useDismissNotice, useHistory, useOperationList, useProjects } from '../lib/engine-state.ts';
import { formatWhen, refLabel } from '../lib/format.ts';
import type { Navigate, Route } from '../lib/route.ts';
import { Agent, Alert } from './icons.tsx';
import { Button } from './ui/button.tsx';

// What agents did or asked for while the app was open (M1 plan §4.1, §9.1),
// as banners under the header. They never block the app: each one is answered
// or dismissed on its own, and the settings screen lists every request.

export type ConnectRequest = Extract<OperationStatus, { kind: 'connect-request' }>;
type RestoreNotice = Extract<OperationStatus, { kind: 'restore' }> & { projectId: ProjectId };

const SHOWN = 3;

export function isConnectRequest(op: OperationStatus): op is ConnectRequest {
  return op.kind === 'connect-request';
}

// Answering a request: the user picks the folder in the native dialog (which
// opens at the folder the agent named), then reviews it as any other folder.
// Only the folder picked there is granted.
export function useAnswerRequest(navigate: Navigate) {
  const [picking, setPicking] = useState(false);
  const answer = async (request: ConnectRequest) => {
    setPicking(true);
    try {
      const root = await chooseFolder(request.request.root);
      if (root) navigate({ name: 'review', root, requestId: request.operationId });
    } finally {
      setPicking(false);
    }
  };
  return { answer: (request: ConnectRequest) => void answer(request), picking };
}

function shortError(error: unknown): string {
  return errorCopy(
    error instanceof DtError ? error.code : 'INTERNAL_ERROR',
    error instanceof DtError ? error.details : {},
  ).title;
}

export function OperationBanners({ route, navigate }: { route: Route; navigate: Navigate }) {
  const list = useOperationList();
  if (!list.data) return null;
  // The settings screen lists every request, and the one being answered on
  // the review screen is shown there.
  const answering = route.name === 'review' ? route.requestId : undefined;
  const requests =
    route.name === 'settings'
      ? []
      : list.data.requests.filter(isConnectRequest).filter((r) => r.operationId !== answering);
  const notices = list.data.notices.filter((n): n is RestoreNotice => n.kind === 'restore' && n.projectId !== null);
  if (requests.length === 0 && notices.length === 0) return null;

  return (
    <section
      aria-label="agent 的請求與通知"
      className="flex shrink-0 flex-col divide-y divide-line border-b border-line"
    >
      {requests.slice(0, SHOWN).map((r) => (
        <RequestBanner key={r.operationId} request={r} navigate={navigate} />
      ))}
      {requests.length > SHOWN && (
        <div className="flex items-center gap-3 bg-agent-soft px-5 py-1.5 text-[12px] text-ink-2">
          <span className="flex-1">另外還有 {requests.length - SHOWN} 個 agent 請求。</span>
          <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings' })}>
            查看全部請求
          </Button>
        </div>
      )}
      {notices.slice(0, SHOWN).map((n) => (
        <NoticeBanner key={n.operationId} notice={n} navigate={navigate} />
      ))}
    </section>
  );
}

function RequestBanner({ request, navigate }: { request: ConnectRequest; navigate: Navigate }) {
  const { answer, picking } = useAnswerRequest(navigate);
  const decline = useDeclineRequest();
  return (
    <div className="flex items-center gap-3 bg-agent-soft px-5 py-2 text-[13px] text-ink" role="status">
      <Agent className="size-4 shrink-0 text-agent" />
      <div className="min-w-0 flex-1">
        <p className="truncate" title={request.request.root}>
          Agent 請求連接資料夾：{request.request.root}
        </p>
        <p className="truncate text-[12px] text-ink-3">
          經 {ORIGIN_LABEL[request.origin]} · {formatWhen(request.createdAt)}
          {request.request.name ? ` · 建議名稱「${request.request.name}」` : ''}
          {decline.isError && <span className="text-danger"> · 無法拒絕：{shortError(decline.error)}</span>}
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => answer(request)} disabled={picking || decline.isPending}>
        選擇資料夾…
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => decline.mutate(request.operationId)}
        disabled={picking || decline.isPending}
      >
        拒絕
      </Button>
    </div>
  );
}

// An agent's restore, naming the protection version that holds what the
// folder had before.
function NoticeBanner({ notice, navigate }: { notice: RestoreNotice; navigate: Navigate }) {
  const projects = useProjects();
  const history = useHistory(notice.projectId);
  const dismiss = useDismissNotice();
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? [];
  const name = projects.data?.find((p) => p.projectId === notice.projectId)?.name || '專案';
  const origin = ORIGIN_LABEL[notice.origin];
  const target = refLabel(entries, notice.target);
  const stopped = notice.state === 'recovery-required';
  const text = stopped
    ? `Agent 經 ${origin} 把「${name}」回復到 ${target} 時中途停止了，需要你完成或還原。`
    : notice.protection
      ? `Agent 經 ${origin} 把「${name}」回復到 ${target}；回復前的內容保存在 ${refLabel(entries, notice.protection)}。`
      : `Agent 經 ${origin} 把「${name}」回復到 ${target}；回復前沒有未保存的變更。`;
  return (
    <div
      className={
        stopped
          ? 'flex items-center gap-3 bg-warn-soft px-5 py-2 text-[13px] text-warn'
          : 'flex items-center gap-3 bg-agent-soft px-5 py-2 text-[13px] text-ink'
      }
      role="status"
    >
      {stopped ? <Alert className="size-4 shrink-0" /> : <Agent className="size-4 shrink-0 text-agent" />}
      <div className="min-w-0 flex-1">
        <p>{text}</p>
        <p className="text-[12px] text-ink-3">
          {formatWhen(notice.updatedAt)}
          {dismiss.isError && <span className="text-danger"> · {shortError(dismiss.error)}</span>}
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => navigate({ name: 'project', projectId: notice.projectId })}>
        查看
      </Button>
      <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(notice.operationId)} disabled={dismiss.isPending}>
        知道了
      </Button>
    </div>
  );
}
