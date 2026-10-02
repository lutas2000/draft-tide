import { useState, type ReactNode } from 'react';
import {
  DtError,
  type ErrorInfo,
  type FolderReview,
  type OperationId,
  type ProjectId,
  type RepoBlocker,
} from '@draft-tide/contracts';
import { Agent, Alert, Check, ChevronLeft, FileIcon, Folder, Info } from '../components/icons.tsx';
import { isConnectRequest, type ConnectRequest } from '../components/operation-banners.tsx';
import { ProgressLine } from '../components/progress.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Details } from '../components/ui/details.tsx';
import { engineCall } from '../lib/bridge.ts';
import { cn } from '../lib/cn.ts';
import { CONFIG_REASON_COPY, ENTRY_KIND_COPY, ORIGIN_LABEL, WARNING_COPY, blockerCopy } from '../lib/copy.ts';
import { useBind, useOperationList, useOperationProgress, useReview } from '../lib/engine-state.ts';
import { formatBytes } from '../lib/format.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// 範圍審查 (M1 plan §4.1, §6.2): what connecting this folder means, before
// anything is written. Confirming connects it (git init if needed, then
// .drafttide.json) and saves the first version. Reached from an agent's
// request (requestId), connecting also answers that request (M1 plan §9.1).

const inputClass =
  'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm focus:border-tide-500 focus:outline-none focus-visible:outline-2';

function Section({
  title,
  aside,
  children,
  tone,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  tone?: 'warn' | 'danger';
}) {
  return (
    <Card
      className={cn(
        'p-5',
        tone === 'warn' && 'border-warn-line bg-warn-soft/40',
        tone === 'danger' && 'border-danger-line bg-danger-soft/40',
      )}
    >
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {aside && <span className="text-[13px] text-ink-2">{aside}</span>}
      </div>
      {children}
    </Card>
  );
}

function Samples({ paths, more }: { paths: string[]; more: number }) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-raised p-3">
      {paths.map((p) => (
        <li key={p} className="truncate font-mono text-[12px] text-ink-2" title={p}>
          {p}
        </li>
      ))}
      {more > 0 && <li className="text-[12px] text-ink-3">另外 {more} 項…</li>}
    </ul>
  );
}

function BlockerItem({ blocker }: { blocker: RepoBlocker }) {
  const copy = blockerCopy(blocker);
  const sample = Array.isArray(blocker.details['sample']) ? (blocker.details['sample'] as string[]) : [];
  return (
    <li className="rounded-md border border-line bg-surface px-4 py-3">
      <p className="font-medium text-ink">{copy.title}</p>
      <p className="mt-0.5 text-[13px] text-ink-2">{copy.next}</p>
      {sample.length > 0 && (
        <p className="mt-1 truncate font-mono text-[12px] text-ink-3" title={sample.join('\n')}>
          {sample.join('、')}
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-ink-3">
        {blocker.code} · {blocker.reason}
      </p>
    </li>
  );
}

// What the agent asked for. Its name and preview entry are only suggestions,
// filled in for the user to change.
function RequestNote({ root, request }: { root: string; request: ConnectRequest | null }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-agent-soft px-3 py-2 text-[13px] text-ink-2" role="note">
      <Agent className="mt-0.5 size-4 shrink-0 text-agent" />
      <span>
        {request ? (
          <>
            Agent 經 {ORIGIN_LABEL[request.origin]} 請求連接資料夾
            {request.request.root !== root && (
              <>
                {' '}
                <code className="font-mono text-[12px]">{request.request.root}</code>
                ，你選的是另一個資料夾
              </>
            )}
            。確認並連接之後，就會回覆這個請求；不想連接，可以返回並拒絕它。
          </>
        ) : (
          <>這個 agent 請求已經不在等待中（已經回覆，或被撤回）。仍然可以連接這個資料夾。</>
        )}
      </span>
    </p>
  );
}

export function ReviewScreen({
  root,
  requestId,
  navigate,
}: {
  root: string;
  requestId?: OperationId;
  navigate: Navigate;
}) {
  const review = useReview(root);
  const operations = useOperationList();
  // The request as it was when this screen opened: connecting answers it, and
  // the note shouldn't change under the user while that happens. Its
  // suggestions fill the form, so the form waits for the list (or its failure).
  const [opened, setOpened] = useState<{ request: ConnectRequest | null } | null>(null);
  if (requestId !== undefined && opened === null && !operations.isPending) {
    const found = operations.data?.requests.filter(isConnectRequest).find((r) => r.operationId === requestId);
    setOpened({ request: found ?? null });
  }
  const request = opened?.request ?? null;
  const waitingForRequest = requestId !== undefined && opened === null;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-6 px-page pt-6 pb-24">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'home' })}>
          <ChevronLeft />
          返回
        </Button>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">確認保存範圍</h1>
          <p className="text-[13px] text-ink-2">
            保存第一版之前，先確認哪些檔案會被保存。確認之前不會改動資料夾裡的任何東西。
          </p>
        </div>
      </div>
      {requestId !== undefined && opened !== null && <RequestNote root={root} request={request} />}
      {review.isPending || waitingForRequest ? (
        <Card className="px-5 py-10 text-center text-ink-3" role="status">
          正在檢查資料夾…
        </Card>
      ) : review.isError ? (
        <div className="flex flex-col gap-3">
          <ErrorNote error={review.error} />
          <div className="flex gap-2">
            <Button onClick={() => void review.refetch()}>重新檢查</Button>
            <Button variant="ghost" onClick={() => navigate({ name: 'home' })}>
              改選其他資料夾
            </Button>
          </div>
        </div>
      ) : (
        <ReviewBody
          review={review.data}
          navigate={navigate}
          recheck={() => void review.refetch()}
          rechecking={review.isFetching}
          request={request}
          {...(requestId !== undefined ? { requestId } : {})}
        />
      )}
    </div>
  );
}

function ReviewBody({
  review,
  navigate,
  recheck,
  rechecking,
  request,
  requestId,
}: {
  review: FolderReview;
  navigate: Navigate;
  recheck: () => void;
  rechecking: boolean;
  request: ConnectRequest | null;
  requestId?: OperationId;
}) {
  const bind = useBind();
  const [name, setName] = useState(request?.request.name || review.suggestedName);
  const included = review.entryFiles.filter((e) => e.status === 'included').map((e) => e.path);
  const suggestedEntry = request?.request.entryFiles.find(
    (f) => included.includes(f) || review.entryCandidates.includes(f),
  );
  const [entry, setEntry] = useState<string>(suggestedEntry ?? included[0] ?? review.entryCandidates[0] ?? '');
  const [asNewProject, setAsNewProject] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'saving'>('idle');
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [error, setError] = useState<unknown>(null);
  const progress = useOperationProgress(projectId ?? '');

  const { binding, config, repo } = review;
  const conflict = binding.status === 'bound-elsewhere' && binding.available && !asNewProject;
  const problems: string[] = [];
  if (review.blockers.length > 0) problems.push('這個資料夾的 Git 狀態需要先處理。');
  if (review.unsupported.count > 0) problems.push(`還有 ${review.unsupported.count} 個無法保存的項目。`);
  if (config.status === 'invalid') problems.push('專案設定檔（.drafttide.json）無法使用。');
  if (conflict) problems.push('這個資料夾的專案已經連接在其他位置。');
  const canConfirm = problems.length === 0 && phase === 'idle' && binding.status !== 'bound-here' && !rechecking;
  const entryChoices = [...new Set([...included, ...review.entryCandidates])];

  const confirm = async () => {
    setError(null);
    setPhase('connecting');
    let connected: ProjectId;
    try {
      const r = await bind.mutateAsync({
        root: review.root,
        name,
        entryFiles: entry ? [entry] : [],
        reviewToken: review.reviewToken,
        ...(asNewProject ? { asNewProject: true } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
      connected = r.project.projectId;
    } catch (e) {
      setError(e);
      setPhase('idle');
      if (e instanceof DtError && e.code === 'SCOPE_CHANGED') recheck();
      return;
    }
    setProjectId(connected);
    setPhase('saving');
    let notice: ErrorInfo | undefined;
    try {
      await engineCall('snapshot.create', { projectId: connected });
    } catch (e) {
      // Connected, but the first version wasn't saved: the project page says
      // why and offers to save again. NO_CHANGES means it already is.
      if (!(e instanceof DtError && e.code === 'NO_CHANGES')) {
        notice =
          e instanceof DtError
            ? e.toInfo()
            : { code: 'INTERNAL_ERROR', message: String(e), details: {}, retryable: false };
      }
    }
    navigate({ name: 'project', projectId: connected, ...(notice ? { notice } : {}) });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6">
      <div className="flex flex-col gap-5">
        <Section title="專案">
          <div className="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-4">
            <label htmlFor="project-name" className="text-[13px] text-ink-2">
              專案名稱
            </label>
            <input
              id="project-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              disabled={phase !== 'idle'}
              className={inputClass}
            />
            <span className="text-[13px] text-ink-2">資料夾</span>
            <span className="flex min-w-0 items-center gap-2">
              <Folder className="size-4 shrink-0 text-tide-600" />
              <span className="shrink-0 font-medium">{review.folderName}</span>
              <span className="min-w-0 truncate text-[12px] text-ink-3" title={review.root}>
                {review.root}
              </span>
            </span>
            <label htmlFor="entry" className="text-[13px] text-ink-2">
              預覽入口
            </label>
            <span className="flex items-center gap-3">
              <select
                id="entry"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                disabled={phase !== 'idle'}
                className="h-9 max-w-[320px] rounded-md border border-line-strong bg-surface px-2.5 font-mono text-[13px] focus:border-tide-500"
              >
                <option value="">（不指定）</option>
                {entryChoices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-ink-3">之後的畫面預覽與比較會從這個頁面開始。</span>
            </span>
            <span className="self-start pt-0.5 text-[13px] text-ink-2">版本歷史</span>
            <p className="text-[13px] text-ink-2">
              {repo.hasRepo && repo.branch === null ? (
                <>這個資料夾已經是 Git repo，但目前無法使用（見下方說明）。</>
              ) : repo.hasRepo ? (
                <>
                  這個資料夾已經是 Git repo（branch <code className="font-mono">{repo.branch}</code>
                  ）。Draft Tide 的版本會接在目前的歷史之後，不會改動其他 branch、tag 或 Git 設定。
                </>
              ) : (
                <>
                  確認後會在資料夾裡建立 <code className="font-mono">.git</code>（branch{' '}
                  <code className="font-mono">main</code>
                  ），版本歷史就存在這個資料夾裡：複製整個資料夾（含 .git）會一起帶走歷史，刪掉 .git 就會失去它。
                </>
              )}
            </p>
          </div>
        </Section>

        {binding.status === 'bound-here' && (
          <Section title="這個資料夾已經連接" tone="warn">
            <p className="text-[13px] text-ink-2">它已經是專案「{binding.project.name}」。不需要再連接一次。</p>
            <Button
              className="mt-3"
              onClick={() => navigate({ name: 'project', projectId: binding.project.projectId })}
            >
              開啟專案
            </Button>
          </Section>
        )}
        {binding.status === 'bound-elsewhere' &&
          (binding.available ? (
            <Section title="這個資料夾的專案已經連接在其他位置" tone="warn">
              <p className="text-[13px] text-ink-2">
                資料夾裡的 .drafttide.json 指向專案「{binding.project.name}」，它已連接在{' '}
                <code className="font-mono text-[12px]">{binding.project.root}</code>
                。這個資料夾可能是複製出來的。
              </p>
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={asNewProject}
                  onChange={(e) => setAsNewProject(e.target.checked)}
                  disabled={phase !== 'idle'}
                />
                以新專案連接（產生新的專案 ID，寫入這個資料夾的 .drafttide.json）
              </label>
            </Section>
          ) : (
            <Section title="這個專案原本連接在其他位置">
              <p className="text-[13px] text-ink-2">
                專案「{binding.project.name}」原本連接在{' '}
                <code className="font-mono text-[12px]">{binding.project.root}</code>
                ，目前找不到那個資料夾。確認後改為連接這個資料夾。
              </p>
            </Section>
          ))}
        {config.status === 'invalid' && (
          <Section title="專案設定檔（.drafttide.json）無法使用" tone="danger">
            <p className="text-[13px] text-ink-2">
              {CONFIG_REASON_COPY[config.reason]}。Draft Tide 不會覆寫它；修正或移除這個檔案後再檢查一次。
            </p>
          </Section>
        )}
        {config.status === 'valid' && binding.status === 'new' && (
          <p className="flex items-start gap-2 rounded-md bg-tide-50 px-3 py-2 text-[13px] text-tide-900">
            <Info className="mt-0.5 size-4 shrink-0 text-tide-600" />
            資料夾裡已經有專案設定（.drafttide.json），會沿用它的專案 ID 與排除規則。
          </p>
        )}

        {review.blockers.length > 0 && (
          <Section title="需要先處理" tone="danger">
            <ul className="flex flex-col gap-2">
              {review.blockers.map((b) => (
                <BlockerItem key={`${b.code}:${b.reason}`} blocker={b} />
              ))}
            </ul>
          </Section>
        )}

        {!review.scopeListed ? (
          <Section title="保存範圍">
            <p className="text-[13px] text-ink-2">處理上面的問題、再檢查一次之後，這裡會列出會保存與不會保存的檔案。</p>
          </Section>
        ) : (
          <>
            <Section
              title="會保存的內容"
              aside={
                <>
                  <strong className="text-ink">{review.included.files} 個檔案</strong> ·{' '}
                  {formatBytes(review.included.bytes)}
                </>
              }
            >
              <p className="mb-3 text-[13px] text-ink-2">
                每個版本都保存這些檔案的原始內容。沒有變動的檔案不會重複佔用空間。
              </p>
              {review.included.largest.length > 0 && (
                <>
                  <p className="mb-2 text-[12px] text-ink-3">較大的檔案</p>
                  <ul className="flex flex-col gap-1.5">
                    {review.included.largest.map((f) => (
                      <li key={f.path} className="flex items-center gap-2 text-[13px]">
                        <FileIcon className="size-4 shrink-0 text-ink-3" />
                        <span className="flex-1 truncate font-mono">{f.path}</span>
                        <span className="text-ink-2">{formatBytes(f.size)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {review.deleted.count > 0 && (
                <Details
                  className="mt-4"
                  summary={`${review.deleted.count} 個已在 Git 中的檔案不在資料夾裡，第一版不會包含它們`}
                >
                  <Samples paths={review.deleted.sample} more={review.deleted.count - review.deleted.sample.length} />
                </Details>
              )}
            </Section>

            {review.unsupported.count > 0 && (
              <Section title="無法保存的項目" aside={`${review.unsupported.count} 項`} tone="warn">
                <p className="mb-3 text-[13px] text-ink-2">
                  這些項目在保存範圍內，但無法照原樣保存。Draft Tide 不會悄悄略過它們：請移除、改名或替換後再檢查一次。
                </p>
                <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
                  {review.unsupported.entries.map((u) => (
                    <li key={`${u.kind}:${u.path}`} className="flex items-center gap-3 px-3 py-2">
                      <Alert className="size-4 shrink-0 text-warn" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={u.path}>
                        {u.path}
                      </span>
                      <Badge tone="outline">{ENTRY_KIND_COPY[u.kind]}</Badge>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="不會保存的項目" aside={`${review.excluded.count} 項`}>
              <p className="mb-3 text-[13px] text-ink-2">
                依照 .gitignore 與 Draft Tide
                的預設排除（node_modules、.env、金鑰、暫存檔等），這些新檔案不會被保存。已經在 Git
                中的檔案一律保存，不受排除規則影響。
              </p>
              {review.excluded.count > 0 ? (
                <Samples paths={review.excluded.sample} more={review.excluded.count - review.excluded.sample.length} />
              ) : (
                <p className="text-[13px] text-ink-3">沒有被排除的項目。</p>
              )}
            </Section>
          </>
        )}

        {repo.warnings.length > 0 && (
          <Section title="提醒">
            <ul className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              {repo.warnings.map((w) => (
                <li key={w.reason} className="flex items-start gap-2">
                  <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  {WARNING_COPY[w.reason]}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <div className="sticky top-6 flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-5">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
            {review.scopeListed && (
              <>
                <dt className="text-ink-2">會保存</dt>
                <dd className="font-medium">
                  {review.included.files} 個檔案 · {formatBytes(review.included.bytes)}
                </dd>
                <dt className="text-ink-2">不會保存</dt>
                <dd className="font-medium">{review.excluded.count} 項</dd>
              </>
            )}
            {review.freeBytes !== null && (
              <>
                <dt className="text-ink-2">可用空間</dt>
                <dd className="font-medium">{formatBytes(review.freeBytes)}</dd>
              </>
            )}
          </dl>
          {problems.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
              {problems.map((p) => (
                <li key={p} className="flex items-start gap-1.5">
                  <Alert className="mt-0.5 size-3.5 shrink-0" />
                  {p}
                </li>
              ))}
            </ul>
          )}
          {phase === 'saving' ? (
            <ProgressLine event={progress} fallback="保存第一版…" />
          ) : (
            <Button variant="primary" size="lg" disabled={!canConfirm} onClick={() => void confirm()}>
              {phase === 'connecting' ? (
                '連接資料夾…'
              ) : (
                <>
                  <Check />
                  確認並保存第一版
                </>
              )}
            </Button>
          )}
          <Button variant="secondary" onClick={recheck} disabled={phase !== 'idle' || rechecking}>
            {rechecking ? '檢查中…' : '重新檢查'}
          </Button>
          {error !== null && <ErrorNote error={error} />}
          <p className="text-[12px] text-ink-3">
            確認後會{repo.hasRepo ? '' : '建立 .git、'}寫入專案設定檔
            .drafttide.json，然後保存第一版。設計檔案本身不會被改動。
          </p>
        </Card>
      </div>
    </div>
  );
}
