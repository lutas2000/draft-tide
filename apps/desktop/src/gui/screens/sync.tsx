import { useState } from 'react';
import {
  DtError,
  type GitHubRepo,
  type OperationId,
  type ProjectId,
  type RemoteConnectPlan,
  type SyncPullResult,
  type SyncStatus,
} from '@draft-tide/contracts';
import { Alert, Check, Cloud } from '../components/icons.tsx';
import { ProgressLine } from '../components/progress.tsx';
import { ConfirmDialog } from '../components/ui/alert-dialog.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { Details } from '../components/ui/details.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { openExternal } from '../lib/bridge.ts';
import { COLLISION_COPY, SYNC_STATE_LABEL, errorCopy } from '../lib/copy.ts';
import {
  useAuthStatus,
  useConnectApply,
  useConnectPlan,
  useDisconnect,
  useOperationProgress,
  usePullApply,
  usePullPlan,
  usePush,
  useRemoteRefresh,
  useRemoteRepos,
  useRemoteStatus,
} from '../lib/engine-state.ts';
import { formatBytes, formatWhen } from '../lib/format.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// GitHub sync on the project page (M1 plan §4.1 帳號與同步, §10): the
// project's repository and sync state, pushing now, getting updates (a plan
// the user confirms), connecting a repository the user created (with the
// first-push review), and stopping. Saving never waits for any of it.

const SYNC_OPS = new Set(['remote.connectApply', 'sync.push', 'sync.pullApply']);

function githubPage(status: SyncStatus): string | null {
  return status.remote ? `https://github.com/${status.remote.owner}/${status.remote.name}` : null;
}

export function SyncCard({
  projectId,
  navigate,
  connectRequestId,
}: {
  projectId: ProjectId;
  navigate: Navigate;
  // An agent asked the user to connect this project: open the wizard.
  connectRequestId?: OperationId | undefined;
}) {
  const status = useRemoteStatus(projectId);
  const auth = useAuthStatus();
  const push = usePush(projectId);
  const refresh = useRemoteRefresh(projectId);
  const disconnect = useDisconnect(projectId);
  const progress = useOperationProgress(projectId);
  const [connecting, setConnecting] = useState(connectRequestId !== undefined);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<SyncPullResult | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const signedIn = auth.data?.state === 'signed-in';
  const s = status.data;
  const state = s ? SYNC_STATE_LABEL[s.state] : null;
  const syncing = progress !== null && SYNC_OPS.has(progress.operation);
  const error = push.error ?? refresh.error ?? disconnect.error;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Cloud className="size-4 text-ink-3" />
            GitHub 同步
          </span>
        }
        description={
          s?.remote ? (
            <span>
              {s.remote.owner}/{s.remote.name} · {s.remote.branch}
              {s.remote.visibility === 'public' && <span className="text-warn"> · 公開</span>}
            </span>
          ) : (
            '這個專案只在這台電腦上，沒有異地備份。'
          )
        }
        action={state && <Badge tone={state.tone}>{state.label}</Badge>}
      />
      <CardBody className="flex flex-col gap-3">
        {status.isError && <ErrorNote error={status.error} />}
        {s && !s.remote && (
          <div className="flex flex-wrap items-center gap-2">
            {signedIn ? (
              <Button variant="primary" onClick={() => setConnecting(true)}>
                連接 GitHub repo…
              </Button>
            ) : (
              <Button onClick={() => navigate({ name: 'account' })}>先登入 GitHub</Button>
            )}
            <span className="text-[12px] text-ink-3">把歷史同步到你自己在 GitHub 建立的 repo。</span>
          </div>
        )}
        {s?.remote && (
          <>
            <p className="text-[13px] text-ink-2">
              {s.state === 'pending' && s.ahead !== null && `有 ${s.ahead} 個 commit 等待推送。`}
              {s.state === 'behind' && s.behind !== null && `GitHub 上有 ${s.behind} 個新的 commit，可以取得更新。`}
              {s.state === 'diverged' && '你和 GitHub 都有新版本，兩邊都沒有改動。Draft Tide 目前不會合併兩邊。'}
              {s.state === 'synced' && 'GitHub 上有這個專案的全部版本。'}
              {s.lastPushAt && <span className="text-ink-3"> 最後推送：{formatWhen(s.lastPushAt)}。</span>}
            </p>
            {s.lastError && s.state !== 'synced' && (
              <SyncProblem code={s.lastError.code} reason={s.lastError.reason} at={s.lastError.at} />
            )}
            {syncing && <ProgressLine event={progress} fallback="同步中…" />}
            {pulled && (
              <p className="flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-[13px] text-ok" role="status">
                <Check className="size-4" />
                已取得 GitHub 的更新：寫入 {pulled.written} 個、刪除 {pulled.deleted} 個檔案。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => push.mutate()} disabled={push.isPending || syncing}>
                {push.isPending ? '推送中…' : '立即推送'}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setPulled(null);
                  setPulling(true);
                }}
                disabled={syncing}
              >
                取得更新…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? '檢查中…' : '檢查 GitHub'}
              </Button>
              {githubPage(s) && (
                <Button size="sm" variant="ghost" onClick={() => void openExternal(githubPage(s) ?? '')}>
                  在 GitHub 查看
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>
                停止同步
              </Button>
            </div>
          </>
        )}
        {error && !(error instanceof DtError && error.code === 'NO_CHANGES') && <ErrorNote error={error} />}
      </CardBody>
      {connecting && (
        <ConnectDialog projectId={projectId} requestId={connectRequestId} onClose={() => setConnecting(false)} />
      )}
      {pulling && (
        <PullDialog
          projectId={projectId}
          onClose={() => setPulling(false)}
          onPulled={(r) => {
            setPulling(false);
            setPulled(r);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="停止同步這個專案？"
        confirmLabel="停止同步"
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined, { onSettled: () => setConfirmStop(false) })}
      >
        <p>之後保存的版本不會再推送到 GitHub。這台電腦和 GitHub 上的內容都不會被刪除，資料夾的 Git 設定也保持原樣。</p>
      </ConfirmDialog>
    </Card>
  );
}

function SyncProblem({ code, reason, at }: { code: DtError['code']; reason: string | null; at: string }) {
  const copy = errorCopy(code, reason ? { reason } : {});
  return (
    <div className="flex gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
      <Alert className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">{copy.title}</p>
        <p className="text-ink-2">{copy.next}</p>
        <p className="mt-0.5 text-[11px] text-ink-3">
          {code}
          {reason ? ` · ${reason}` : ''} · {formatWhen(at)}
        </p>
      </div>
    </div>
  );
}

// ---- Connecting a repository the user created (M1 plan §10.2, §10.6)

function ConnectDialog({
  projectId,
  requestId,
  onClose,
}: {
  projectId: ProjectId;
  requestId?: OperationId | undefined;
  onClose: () => void;
}) {
  const auth = useAuthStatus();
  const repos = useRemoteRepos(auth.data?.state === 'signed-in');
  const plan = useConnectPlan(projectId);
  const apply = useConnectApply(projectId);
  const progress = useOperationProgress(projectId);
  const [picked, setPicked] = useState<GitHubRepo | null>(null);
  const [setOrigin, setSetOrigin] = useState<boolean | null>(null);
  const links = auth.data?.links ?? null;
  const reviewed = plan.data ?? null;
  const done = apply.data ?? null;
  const busy = plan.isPending || apply.isPending;

  const footer = done ? (
    <Button variant="primary" onClick={onClose}>
      完成
    </Button>
  ) : reviewed ? (
    <>
      <Button
        onClick={() => {
          plan.reset();
          apply.reset();
        }}
        disabled={busy}
      >
        返回
      </Button>
      <Button
        variant="primary"
        disabled={busy || reviewed.blocked !== null}
        onClick={() =>
          apply.mutate({
            planId: reviewed.planId,
            setOrigin: setOrigin ?? (reviewed.origin.url === null || reviewed.origin.matches),
            ...(requestId ? { requestId } : {}),
          })
        }
      >
        {apply.isPending ? '連接中…' : reviewed.review ? '連接並推送' : '連接'}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={busy}>
        取消
      </Button>
      <Button
        variant="primary"
        disabled={!picked || busy}
        onClick={() => picked && plan.mutate({ owner: picked.owner, name: picked.name })}
      >
        {plan.isPending ? '檢查中…' : '檢查這個 repo'}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="連接 GitHub repo"
      description="Draft Tide 不會替你建立 repo：請在 GitHub 建立一個空的 repo，再把 Draft Tide 安裝到它上面。"
      busy={busy}
      footer={footer}
    >
      {done ? (
        <div className="flex flex-col gap-2 text-[13px]" role="status">
          <p className="flex items-center gap-2 font-medium text-ok">
            <Check className="size-4" />
            已連接 {done.remote.owner}/{done.remote.name}
          </p>
          {done.push && (
            <p className="text-ink-2">已推送 {done.push.commits} 個 commit。之後每次保存都會在背景推送。</p>
          )}
          {!done.push && done.status.lastError && (
            <SyncProblem
              code={done.status.lastError.code}
              reason={done.status.lastError.reason}
              at={done.status.lastError.at}
            />
          )}
          {done.status.state === 'behind' && (
            <p className="text-ink-2">GitHub 上有較新的版本，可以用「取得更新」取回。</p>
          )}
        </div>
      ) : reviewed ? (
        <Review plan={reviewed} setOrigin={setOrigin} onSetOrigin={setSetOrigin} />
      ) : (
        <ol className="flex flex-col gap-4 text-[13px]">
          <li>
            <p className="font-medium text-ink">1. 在 GitHub 建立一個空的 repo</p>
            <p className="mt-0.5 text-ink-2">
              建議選 Private。不要勾選 README、.gitignore 或 license：repo 必須是空的。
            </p>
            {links && (
              <Button size="sm" className="mt-2" onClick={() => void openExternal(links.newRepo)}>
                開啟 GitHub 建立頁面
              </Button>
            )}
          </li>
          <li>
            <p className="font-medium text-ink">2. 把 Draft Tide 安裝到這個 repo</p>
            <p className="mt-0.5 text-ink-2">在安裝頁面選「Only select repositories」，只選剛建立的 repo。</p>
            {links && (
              <Button size="sm" className="mt-2" onClick={() => void openExternal(links.installApp)}>
                開啟安裝頁面
              </Button>
            )}
          </li>
          <li>
            <div className="flex items-center justify-between">
              <p className="font-medium text-ink">3. 選擇 repo</p>
              <Button size="sm" variant="ghost" onClick={() => void repos.refetch()} disabled={repos.isFetching}>
                {repos.isFetching ? '讀取中…' : '重新整理'}
              </Button>
            </div>
            {repos.isError && <ErrorNote error={repos.error} className="mt-2" />}
            {repos.data && repos.data.repos.length === 0 && (
              <p className="mt-1 text-ink-3">還沒有安裝 Draft Tide 的 repo。完成上面兩步後按「重新整理」。</p>
            )}
            {repos.data && repos.data.repos.length > 0 && (
              <ul
                className="dt-scroll mt-2 max-h-48 divide-y divide-line overflow-y-auto rounded-md border border-line"
                aria-label="可以連接的 repo"
              >
                {repos.data.repos.map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-raised">
                      <input type="radio" name="repo" checked={picked?.id === r.id} onChange={() => setPicked(r)} />
                      <span className="min-w-0 flex-1 truncate">
                        {r.owner}/{r.name}
                      </span>
                      <Badge tone={r.visibility === 'public' ? 'warn' : 'neutral'}>
                        {r.visibility === 'public' ? '公開' : 'Private'}
                      </Badge>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        </ol>
      )}
      {apply.isPending && <ProgressLine event={progress} fallback="推送到 GitHub…" />}
      {(plan.error ?? apply.error) && <ErrorNote error={plan.error ?? apply.error} className="mt-3" />}
    </Dialog>
  );
}

const RELATION_TEXT: Record<RemoteConnectPlan['relation'], string> = {
  empty: 'repo 是空的：會推送這個專案的整段歷史，GitHub 會把這個 branch 設為預設 branch。',
  ahead: 'repo 已經有這個專案較早的版本，會推送之後的新版本。',
  same: 'repo 已經和這個專案相同，不需要推送。',
  behind: 'GitHub 上有這個專案較新的版本。連接後可以用「取得更新」取回。',
  diverged: '你和 GitHub 都有新版本。',
  unrelated: 'repo 裡已經有和這個專案無關的內容。',
};

// The first-push review (M1 plan §10.6): what goes to GitHub, and who can see
// it there. Pushed history can't be taken back by Draft Tide.
function Review({
  plan,
  setOrigin,
  onSetOrigin,
}: {
  plan: RemoteConnectPlan;
  setOrigin: boolean | null;
  onSetOrigin: (v: boolean) => void;
}) {
  const r = plan.review;
  const originDefault = plan.origin.url === null || plan.origin.matches;
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
        {plan.repo.owner}/{plan.repo.name}
        <Badge tone={plan.repo.visibility === 'public' ? 'warn' : 'neutral'}>
          {plan.repo.visibility === 'public' ? '公開' : plan.repo.visibility === 'internal' ? '組織內部' : 'Private'}
        </Badge>
      </p>
      {plan.repo.visibility !== 'private' && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">
          這個 repo 不是 private：{plan.repo.visibility === 'public' ? '任何人' : '組織裡的所有人'}
          都能看到推送的所有版本與檔案。
        </p>
      )}
      <p className="text-ink-2">{RELATION_TEXT[plan.relation]}</p>
      {r && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-raised px-3 py-2">
          <p className="text-ink">
            將推送 {r.versions} 個版本（{r.commits} 個 commit），{r.files} 個檔案內容，共 {formatBytes(r.bytes)}。
          </p>
          {r.overLimit.count > 0 && (
            <p className="text-danger">
              有 {r.overLimit.count} 個檔案超過 GitHub 的 100 MiB 上限，推送會被拒絕：{r.overLimit.sample.join('、')}
            </p>
          )}
          {r.large.count > 0 && (
            <p className="text-warn">
              有 {r.large.count} 個檔案超過 50 MiB，GitHub 會發出警告：{r.large.sample.join('、')}
            </p>
          )}
          {r.suspectedSecrets.count > 0 && (
            <div className="text-warn">
              <p>這些檔案看起來可能含有金鑰、密碼或 token，請確認可以推送：</p>
              <ul className="mt-1 list-inside list-disc text-ink-2">
                {r.suspectedSecrets.sample.slice(0, 10).map((p) => (
                  <li key={p} className="truncate">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!r.secretsScanComplete && <p className="text-[12px] text-ink-3">較大的檔案沒有逐一檢查內容。</p>}
          {r.largest.length > 0 && (
            <Details summary="最大的檔案">
              <ul className="mt-1 text-[12px] text-ink-2">
                {r.largest.map((f) => (
                  <li key={f.path} className="flex justify-between gap-3">
                    <span className="truncate">{f.path}</span>
                    <span className="shrink-0 text-ink-3">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </Details>
          )}
        </div>
      )}
      <label className="flex items-start gap-2 text-ink-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={setOrigin ?? originDefault}
          onChange={(e) => onSetOrigin(e.target.checked)}
        />
        <span>
          同時把這個 repo 設為資料夾的 origin，讓一般的 Git 工具也使用它。
          {plan.origin.url && !plan.origin.matches && (
            <span className="block text-[12px] text-ink-3">目前的 origin：{plan.origin.url}</span>
          )}
        </span>
      </label>
      {plan.blocked && (
        <ErrorNote
          error={new DtError(plan.blocked.code, '', plan.blocked.reason ? { reason: plan.blocked.reason } : {})}
        />
      )}
      {r && <p className="text-[12px] text-ink-3">推送到 GitHub 的歷史無法由 Draft Tide 收回。</p>}
    </div>
  );
}

// ---- Getting updates: fast-forward only (M1 plan §10.4)

function PullDialog({
  projectId,
  onClose,
  onPulled,
}: {
  projectId: ProjectId;
  onClose: () => void;
  onPulled: (r: SyncPullResult) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const plan = usePullPlan(projectId, nonce);
  const apply = usePullApply(projectId);
  const progress = useOperationProgress(projectId);
  const p = plan.data;
  const stale = apply.error instanceof DtError && apply.error.code === 'PLAN_STALE';
  const recheck = () => {
    apply.reset();
    setNonce((n) => n + 1);
  };
  const canApply = p && !p.noop && p.blocked === null && p.target !== null && !apply.isPending;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="取得 GitHub 的更新"
      description="只會快轉到 GitHub 上較新的版本；資料夾必須沒有未保存的變更。"
      busy={apply.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={apply.isPending}>
            關閉
          </Button>
          {stale ? (
            <Button variant="primary" onClick={recheck}>
              重新檢查
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canApply}
              onClick={() => p && apply.mutate(p.planId, { onSuccess: (r) => onPulled(r) })}
            >
              {apply.isPending ? '取得中…' : '取得更新'}
            </Button>
          )}
        </>
      }
    >
      {plan.isPending ? (
        <p className="text-[13px] text-ink-3" role="status">
          向 GitHub 檢查新的版本…
        </p>
      ) : plan.isError ? (
        <ErrorNote error={plan.error} />
      ) : p ? (
        <div className="flex flex-col gap-3 text-[13px]">
          {p.relation === 'equal' && <p className="text-ink-2">已經是最新的，GitHub 上沒有新的版本。</p>}
          {p.relation === 'ahead' && <p className="text-ink-2">GitHub 上沒有新的版本；這台電腦有還沒推送的版本。</p>}
          {p.relation === 'no-remote-branch' && <p className="text-ink-2">GitHub 上還沒有這個 branch。</p>}
          {p.target && (
            <>
              <p className="text-ink">
                GitHub 上有 {p.incoming} 個新的 commit，最新的是
                {p.target.seq !== null ? ` V${p.target.seq}` : ''}「{p.target.title}」。
              </p>
              <p className="text-ink-2">
                會覆寫 {p.summary.overwrite} 個、新增 {p.summary.add} 個、刪除 {p.summary.delete} 個檔案。
              </p>
              {p.changes.length > 0 && (
                <Details summary="檔案清單">
                  <ul className="mt-1 max-h-40 overflow-y-auto text-[12px] text-ink-2">
                    {p.changes.map((c) => (
                      <li key={c.path} className="truncate">
                        {c.change === 'add' ? '新增' : c.change === 'delete' ? '刪除' : '覆寫'} {c.path}
                      </li>
                    ))}
                  </ul>
                </Details>
              )}
            </>
          )}
          {p.collisions.entries.length > 0 && (
            <ul className="text-[12px] text-warn">
              {p.collisions.entries.map((c) => (
                <li key={c.path}>
                  {c.path}：{COLLISION_COPY[c.reason]}
                </li>
              ))}
            </ul>
          )}
          {p.blocked && (
            <ErrorNote error={new DtError(p.blocked.code, '', p.blocked.reason ? { reason: p.blocked.reason } : {})} />
          )}
        </div>
      ) : null}
      {apply.isPending && <ProgressLine event={progress} fallback="取得更新中…" />}
      {apply.error && <ErrorNote error={apply.error} className="mt-3" />}
    </Dialog>
  );
}
