import { useState } from 'react';
import { DtError, type GitHubRepo } from '@draft-tide/contracts';
import { ProgressLine } from '../components/progress.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { chooseFolder } from '../lib/bridge.ts';
import { useAuthStatus, useOpenApply, useOpenPlan, useProgressOf, useRemoteRepos } from '../lib/engine-state.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// 從 GitHub 開啟 (M1 plan §10.7): a repository the app is installed on, into
// an empty folder the user picks (or makes) in the native dialog. Nothing in
// a folder that holds anything is ever overwritten, and nothing in the
// repository runs.
export function OpenFromGitHubDialog({ navigate, onClose }: { navigate: Navigate; onClose: () => void }) {
  const auth = useAuthStatus();
  const signedIn = auth.data?.state === 'signed-in';
  const repos = useRemoteRepos(signedIn);
  const plan = useOpenPlan();
  const apply = useOpenApply();
  const [picked, setPicked] = useState<GitHubRepo | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const p = plan.data ?? null;
  const progressOf = useProgressOf('remote.openApply');
  const busy = plan.isPending || apply.isPending;

  const choose = async () => {
    setChoosing(true);
    try {
      const chosen = await chooseFolder();
      if (chosen) {
        setFolder(chosen);
        plan.reset();
      }
    } finally {
      setChoosing(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="從 GitHub 開啟專案"
      description="把已同步到 GitHub 的專案開到一個空白資料夾，歷史完整保留，之後可以繼續保存。"
      busy={busy}
      footer={
        !signedIn ? (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={() => navigate({ name: 'account' })}>
              先登入 GitHub
            </Button>
          </>
        ) : p ? (
          <>
            <Button onClick={() => plan.reset()} disabled={busy}>
              返回
            </Button>
            <Button
              variant="primary"
              disabled={busy || p.blocked !== null}
              onClick={() =>
                apply.mutate(p.planId, {
                  onSuccess: (r) => navigate({ name: 'project', projectId: r.project.projectId }),
                })
              }
            >
              {apply.isPending ? '開啟中…' : '開啟'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!picked || !folder || busy}
              onClick={() =>
                picked &&
                folder &&
                plan.mutate({ repo: { owner: picked.owner, name: picked.name }, destination: folder })
              }
            >
              {plan.isPending ? '檢查中…' : '檢查'}
            </Button>
          </>
        )
      }
    >
      {!signedIn ? (
        <p className="text-[13px] text-ink-2">需要先登入 GitHub，才能列出你可以開啟的 repo。</p>
      ) : p ? (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="flex items-center gap-2 font-medium text-ink">
            {p.repo.owner}/{p.repo.name}
            <Badge tone={p.repo.visibility === 'public' ? 'warn' : 'neutral'}>
              {p.repo.visibility === 'public' ? '公開' : 'Private'}
            </Badge>
          </p>
          <p className="text-ink-2">
            Branch {p.branch}，開到{p.destination.exists ? '空資料夾' : '新資料夾'}：
            <span className="break-all text-ink">{p.destination.path}</span>
          </p>
          {p.blocked && (
            <ErrorNote error={new DtError(p.blocked.code, '', p.blocked.reason ? { reason: p.blocked.reason } : {})} />
          )}
          {apply.isPending && <ProgressLine event={progressOf} fallback="從 GitHub 取得版本…" />}
        </div>
      ) : (
        <ol className="flex flex-col gap-4 text-[13px]">
          <li>
            <div className="flex items-center justify-between">
              <p className="font-medium text-ink">1. 選擇 repo</p>
              <Button size="sm" variant="ghost" onClick={() => void repos.refetch()} disabled={repos.isFetching}>
                {repos.isFetching ? '讀取中…' : '重新整理'}
              </Button>
            </div>
            {repos.isError && <ErrorNote error={repos.error} className="mt-2" />}
            {repos.data && repos.data.repos.length === 0 && (
              <p className="mt-1 text-ink-3">沒有安裝 Draft Tide 的 repo。</p>
            )}
            {repos.data && repos.data.repos.length > 0 && (
              <ul
                className="dt-scroll mt-2 max-h-48 divide-y divide-line overflow-y-auto rounded-md border border-line"
                aria-label="可以開啟的 repo"
              >
                {repos.data.repos.map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-raised">
                      <input
                        type="radio"
                        name="open-repo"
                        checked={picked?.id === r.id}
                        onChange={() => setPicked(r)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {r.owner}/{r.name}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li>
            <p className="font-medium text-ink">2. 選擇一個空資料夾</p>
            <p className="mt-0.5 text-ink-2">可以在對話框中建立新的資料夾。Draft Tide 不會寫入已經有內容的資料夾。</p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={() => void choose()} disabled={choosing}>
                選擇資料夾…
              </Button>
              {folder && <span className="min-w-0 truncate text-ink-2">{folder}</span>}
            </div>
          </li>
        </ol>
      )}
      {(plan.error ?? apply.error) && <ErrorNote error={plan.error ?? apply.error} className="mt-3" />}
    </Dialog>
  );
}
