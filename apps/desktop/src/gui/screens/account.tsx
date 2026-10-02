import { useState } from 'react';
import type { AuthStatus, LoginOutcome, ProjectSummary } from '@draft-tide/contracts';
import { Check, Cloud, Folder, Person, Spinner } from '../components/icons.tsx';
import { ConfirmDialog } from '../components/ui/alert-dialog.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { copyText, openExternal } from '../lib/bridge.ts';
import { SYNC_STATE_LABEL } from '../lib/copy.ts';
import {
  useAuthStatus,
  useLoginCancel,
  useLoginOutcome,
  useLoginStart,
  useLogout,
  useProjects,
  useRemoteStatus,
} from '../lib/engine-state.ts';
import { formatWhen } from '../lib/format.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// 帳號與同步 (M1 plan §4.1, §10.1): GitHub sign-in through the device flow,
// only here in the app. Skippable: signed out or offline, everything local
// works. The token never reaches this window; it stays in the Engine.

const OUTCOME_COPY: Partial<Record<LoginOutcome, string>> = {
  expired: '驗證碼已經過期，請重新登入。',
  denied: '你在 GitHub 拒絕了授權，沒有登入。',
  failed: '登入沒有完成，請再試一次。',
  cancelled: '已取消登入。',
};

export function AccountScreen({ navigate }: { navigate: Navigate }) {
  const auth = useAuthStatus();
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-page pt-10 pb-24">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">帳號與同步</h1>
        <p className="mt-1 text-ink-2">
          登入 GitHub 是可略過的選項。略過或離線時，所有本機功能照常使用，保存不會等待網路。
        </p>
      </div>
      {auth.isError ? (
        <ErrorNote error={auth.error} />
      ) : auth.isPending ? (
        <Card className="px-5 py-6 text-[13px] text-ink-3">讀取登入狀態…</Card>
      ) : (
        <SignInCard status={auth.data} />
      )}
      <ProjectsSyncCard navigate={navigate} />
    </div>
  );
}

function SignInCard({ status }: { status: AuthStatus }) {
  const start = useLoginStart();
  const cancel = useLoginCancel();
  const logout = useLogout();
  const [outcome, clearOutcome] = useLoginOutcome();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);
  const error = start.error ?? cancel.error ?? logout.error;
  const signIn = () => {
    clearOutcome();
    setCopied(false);
    start.mutate();
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Cloud className="size-4 text-ink-3" />
            GitHub 帳號
          </span>
        }
        description="登入後，可以把專案同步到你自己在 GitHub 建立的 repo，並在其他資料夾或電腦開啟。"
        action={
          status.state === 'signed-in' ? (
            <Badge tone="ok">
              <Check className="size-3" />
              已登入
            </Badge>
          ) : status.state === 'expired' ? (
            <Badge tone="warn">登入已過期</Badge>
          ) : status.state === 'unavailable' ? (
            <Badge tone="outline">無法使用</Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        {status.state === 'unavailable' && (
          <p className="text-[13px] text-ink-2">
            這個版本的 Draft Tide 無法登入 GitHub（
            {status.unavailableReason === 'no-keychain'
              ? '這台電腦沒有可以安全保存登入資訊的鑰匙圈'
              : '沒有設定 GitHub App'}
            ）。所有本機功能照常可用。
          </p>
        )}

        {(status.state === 'signed-out' || status.state === 'expired') && (
          <div className="flex flex-col gap-3">
            {status.state === 'expired' && status.user && (
              <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                {status.user.login} 的登入已過期或在 GitHub 被撤銷。重新登入後，等待中的同步會繼續。
              </p>
            )}
            {outcome && OUTCOME_COPY[outcome] && <p className="text-[13px] text-ink-2">{OUTCOME_COPY[outcome]}</p>}
            <div>
              <Button variant="primary" onClick={signIn} disabled={start.isPending}>
                {start.isPending ? '連線到 GitHub…' : '登入 GitHub'}
              </Button>
            </div>
            <p className="text-[12px] text-ink-3">
              Draft Tide 只會取得你安裝 Draft Tide GitHub App 的 repo 的內容讀寫權限，不會取得你的私人 email。
            </p>
          </div>
        )}

        {status.state === 'signing-in' && status.login && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <p className="text-[13px] text-ink-2">在瀏覽器開啟 GitHub 的驗證頁面，輸入這組驗證碼並授權：</p>
            <div className="flex items-center gap-3">
              <span
                className="rounded-md border border-line-strong bg-raised px-4 py-2 font-mono text-[24px] tracking-[0.2em] text-ink"
                aria-label="驗證碼"
              >
                {status.login.userCode}
              </span>
              <Button size="sm" onClick={() => void copyText(status.login?.userCode ?? '').then((ok) => setCopied(ok))}>
                {copied ? '已複製' : '複製驗證碼'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void openExternal(status.login?.verificationUri ?? '')}>
                開啟 GitHub 驗證頁面
              </Button>
              <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                取消
              </Button>
            </div>
            <p className="flex items-center gap-2 text-[12px] text-ink-3">
              <Spinner className="size-3.5" />
              授權完成後這裡會自動更新。驗證碼在 {formatWhen(status.login.expiresAt)} 前有效。
            </p>
          </div>
        )}

        {status.state === 'signed-in' && status.user && (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-[14px] text-ink">
              <Person className="size-4 text-ink-3" />
              {status.user.name ? `${status.user.name}（@${status.user.login}）` : `@${status.user.login}`}
            </p>
            <p className="text-[13px] text-ink-2">
              新的版本以這個身分記錄：
              <span className="font-mono text-[12px] text-ink">
                {status.identity.name} &lt;{status.identity.email}&gt;
              </span>
              （GitHub 提供的 noreply 信箱，不是你的私人 email）。
            </p>
            <div className="flex flex-wrap gap-2">
              {status.links && (
                <Button size="sm" onClick={() => void openExternal(status.links?.installApp ?? '')}>
                  把 Draft Tide 安裝到 repo…
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setConfirmLogout(true)}>
                登出
              </Button>
            </div>
          </div>
        )}

        {error && <ErrorNote error={error} />}
      </CardBody>
      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="登出 GitHub？"
        confirmLabel="登出"
        busy={logout.isPending}
        onConfirm={() => logout.mutate(undefined, { onSettled: () => setConfirmLogout(false) })}
      >
        <p>登出會刪除這台電腦上的登入資訊，等待中的同步會暫停，本機的版本不受影響。</p>
        <p className="mt-2">
          要撤銷 Draft Tide 對你 GitHub 帳號的存取，請到 GitHub 的 Settings → Applications。
          {status.links && (
            <button
              type="button"
              className="ml-1 text-tide-700 underline"
              onClick={() => void openExternal(status.links?.authorizedApps ?? '')}
            >
              開啟
            </button>
          )}
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function ProjectsSyncCard({ navigate }: { navigate: Navigate }) {
  const projects = useProjects();
  if (!projects.data || projects.data.length === 0) return null;
  return (
    <Card>
      <CardHeader title="專案的同步狀態" description="沒有同步到 GitHub 的專案只在這台電腦上，沒有異地備份。" />
      <CardBody className="p-0">
        <ul className="divide-y divide-line border-t border-line">
          {projects.data.map((p) => (
            <ProjectSyncRow key={p.projectId} project={p} navigate={navigate} />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function ProjectSyncRow({ project, navigate }: { project: ProjectSummary; navigate: Navigate }) {
  const status = useRemoteStatus(project.projectId);
  const state = status.data ? SYNC_STATE_LABEL[status.data.state] : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate({ name: 'project', projectId: project.projectId })}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-raised"
      >
        <Folder className="size-4 shrink-0 text-tide-600" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink">{project.name || '未命名專案'}</span>
          <span className="block truncate text-[12px] text-ink-3">
            {status.data?.remote ? `${status.data.remote.owner}/${status.data.remote.name}` : project.root}
          </span>
        </span>
        {state && <Badge tone={state.tone}>{state.label}</Badge>}
      </button>
    </li>
  );
}
