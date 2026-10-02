import { useState } from 'react';
import {
  DtError,
  type HistoryEntry,
  type ProjectId,
  type RestoreChange,
  type RestorePlan,
  type RestoreResult,
} from '@draft-tide/contracts';
import { Alert, Info } from '../components/icons.tsx';
import { ProgressLine } from '../components/progress.tsx';
import { Badge, type BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Details } from '../components/ui/details.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { COLLISION_COPY, KEPT_SETTINGS_COPY, errorCopy } from '../lib/copy.ts';
import { useCancelOperation, useOperationProgress, useRestoreApply, useRestorePlan } from '../lib/engine-state.ts';
import { entryTime, entryTitle, formatBytes, formatFull, versionLabel } from '../lib/format.ts';
import { ErrorNote } from './error-note.tsx';

// 回復到此版 (M1 plan §4.1, §9.2–9.3): the plan says what restoring would
// overwrite, add and delete, and whether unsaved changes are saved first;
// confirming applies exactly that plan. A plan is single-use, so after any
// failed apply the dialog only offers to check again. The restore shows as
// done only once the Engine answers that it is.

const CHANGE: Record<RestoreChange['change'], { label: string; tone: BadgeTone }> = {
  overwrite: { label: '覆寫', tone: 'warn' },
  add: { label: '新增', tone: 'ok' },
  delete: { label: '刪除', tone: 'danger' },
};

// Cancelling helps only before the first file is written.
const CANCELLABLE_STAGES: ReadonlySet<string> = new Set(['check', 'protect']);

export function RestoreDialog({
  projectId,
  entry,
  target,
  onClose,
  onRestored,
}: {
  projectId: ProjectId;
  entry: HistoryEntry;
  // The entry's permanent reference (snapshot id or commit).
  target: string;
  onClose: () => void;
  onRestored: (result: RestoreResult) => void;
}) {
  const plan = useRestorePlan(projectId, target);
  const apply = useRestoreApply(projectId);
  const cancel = useCancelOperation();
  const progress = useOperationProgress(projectId);
  const [error, setError] = useState<unknown>(null);
  const [cancelAnswer, setCancelAnswer] = useState<'cancelling' | 'too-late' | null>(null);

  const running = apply.isPending;
  // While this apply runs, the project's progress is its own (other changes
  // wait behind the project's write guard).
  const own = running && progress?.operation === 'restore.apply' && progress.origin === 'gui' ? progress : null;
  const cancellable = own !== null && CANCELLABLE_STAGES.has(own.progress.stage) && cancelAnswer === null;
  const checking = plan.isFetching;
  const label = versionLabel(entry);
  const when = entryTime(entry);

  const recheck = () => {
    setError(null);
    setCancelAnswer(null);
    apply.reset();
    void plan.refetch();
  };

  const confirm = async (p: RestorePlan) => {
    setError(null);
    setCancelAnswer(null);
    try {
      onRestored(await apply.mutateAsync(p.planId));
    } catch (e) {
      // Stopped part-way: the project page's recovery card takes over.
      if (e instanceof DtError && e.code === 'RECOVERY_REQUIRED') return onClose();
      setError(e);
    }
  };

  const stop = () => {
    if (!own) return;
    cancel.mutate(own.operationId, {
      onSuccess: (r) => {
        if (r.outcome === 'too-late') setCancelAnswer('too-late');
        else if (r.outcome !== 'ended') setCancelAnswer('cancelling');
      },
    });
  };

  const canConfirm =
    !running &&
    !checking &&
    error === null &&
    !plan.isError &&
    plan.data !== undefined &&
    plan.data.blocked === null &&
    !plan.data.noop;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={running}
      title={label ? `回復到 ${label}` : '回復到這個外部變更'}
      description="把資料夾換成這個版本的內容。歷史只會增加，不會刪除任何版本。"
      footer={
        running ? (
          <>
            <Button onClick={stop} disabled={!cancellable || cancel.isPending}>
              取消回復
            </Button>
            <Button variant="primary" disabled>
              回復中…
            </Button>
          </>
        ) : error !== null || plan.isError ? (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={recheck} disabled={checking}>
              {checking ? '檢查中…' : '重新檢查'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="mr-auto" onClick={recheck} disabled={checking}>
              {checking ? '檢查中…' : '重新檢查'}
            </Button>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={() => plan.data && void confirm(plan.data)} disabled={!canConfirm}>
              確認回復
            </Button>
          </>
        )
      }
    >
      <div className="dt-scroll -mx-1 flex max-h-[min(60vh,560px)] flex-col gap-4 overflow-y-auto px-1">
        <div className="rounded-lg bg-raised px-4 py-3">
          <p className="text-[12px] text-ink-3">回復到</p>
          <p className="truncate font-medium text-ink">
            {label ?? '外部變更'} · {entryTitle(entry)}
          </p>
          {when && <p className="text-[12px] text-ink-3">{formatFull(when)}</p>}
        </div>

        {checking && !running ? (
          <p className="text-[13px] text-ink-3" role="status">
            正在檢查回復會改動哪些檔案…
          </p>
        ) : plan.isError ? (
          <ErrorNote error={plan.error} />
        ) : error !== null ? (
          // The plan was used up by the attempt: only checking again helps.
          <ErrorNote error={error} />
        ) : plan.data ? (
          <PlanBody plan={plan.data} />
        ) : null}

        {running && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <ProgressLine event={own} fallback="準備回復…" />
            {cancelAnswer === 'cancelling' && (
              <p className="text-[13px] text-ink-2" role="status">
                正在取消，會停在安全的步驟…
              </p>
            )}
            {cancelAnswer === 'too-late' && (
              <p className="text-[13px] text-ink-2" role="status">
                已經開始寫入檔案，無法取消；請等它完成。
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PlanBody({ plan }: { plan: RestorePlan }) {
  const { summary, protection, settings, writers } = plan;

  if (plan.noop) {
    return (
      <p className="rounded-md bg-raised px-3 py-2 text-[13px] text-ink" role="status">
        資料夾已經和這個版本相同，不需要回復。
      </p>
    );
  }

  return (
    <>
      {plan.blocked && <Blocked plan={plan} />}

      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            ['覆寫', summary.overwrite],
            ['新增', summary.add],
            ['刪除', summary.delete],
          ] as const
        ).map(([name, n]) => (
          <div key={name} className="rounded-md border border-line px-3 py-2">
            <dt className="text-[12px] text-ink-3">{name}</dt>
            <dd className="text-[18px] font-semibold text-ink">{n}</dd>
          </div>
        ))}
      </dl>
      <p className="-mt-2 text-[12px] text-ink-3">
        和資料夾目前的內容相比（不是和最新版本相比）。
        {summary.unchanged > 0 && `${summary.unchanged} 個檔案已經相同，不會改動。`}
      </p>

      {plan.changes.length > 0 && (
        <Details summary={`查看會改動的檔案（${summary.overwrite + summary.add + summary.delete}）`}>
          <ul className="flex flex-col gap-1">
            {plan.changes.map((c) => (
              <li key={c.path} className="flex items-center gap-2 text-[13px]">
                <Badge tone={CHANGE[c.change].tone} className="w-11 justify-center">
                  {CHANGE[c.change].label}
                </Badge>
                <span className="truncate font-mono text-[12px]" title={c.path}>
                  {c.path}
                </span>
              </li>
            ))}
            {plan.truncated && (
              <li className="text-[12px] text-ink-3">清單太長，只列出前 {plan.changes.length} 個。</li>
            )}
          </ul>
        </Details>
      )}

      <p className="flex items-start gap-2 rounded-md bg-tide-50 px-3 py-2 text-[13px] text-tide-900">
        <Info className="mt-0.5 size-4 shrink-0 text-tide-600" />
        {protection.needed
          ? `目前有 ${protection.unsavedChanges} 個未保存的變更，回復前會先保存成「回復前保護」版本，內容不會遺失。`
          : '資料夾沒有未保存的變更，不需要另外保存回復前保護版本。'}
      </p>

      {settings.action === 'kept' && settings.reason && (
        <p className="text-[13px] text-ink-2">{KEPT_SETTINGS_COPY[settings.reason]}，回復時會保留目前的專案設定。</p>
      )}
      {settings.action === 'restored' && (
        <p className="text-[13px] text-ink-2">專案設定檔（.drafttide.json）也會回到這個版本的內容。</p>
      )}

      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-2 text-[13px] text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            請先停止會寫入這個資料夾的工具（例如 agent
            或編輯器的自動儲存）。回復會逐一確認檔案，被其他程式改過的檔案不會被覆寫。
          </span>
        </p>
        {writers.recentlyModified.count > 0 && (
          <p className="flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
            <Alert className="mt-0.5 size-4 shrink-0" />
            <span>
              有 {writers.recentlyModified.count} 個檔案剛剛被修改，可能還有程式正在寫入：
              <span className="font-mono text-[12px]">
                {writers.recentlyModified.sample.slice(0, 3).join('、')}
                {writers.recentlyModified.count > 3 ? '…' : ''}
              </span>
            </span>
          </p>
        )}
        {writers.draftTideBusy && (
          <p className="flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
            <Alert className="mt-0.5 size-4 shrink-0" />
            這個專案目前有其他保存或回復正在進行。回復會等它完成，並在寫入前重新確認檔案。
          </p>
        )}
      </div>
    </>
  );
}

// Why applying would refuse as things stand, and what the user can do.
function Blocked({ plan }: { plan: RestorePlan }) {
  const { blocked, collisions, space } = plan;
  if (blocked === 'UNTRACKED_FILES') {
    return (
      <div className="rounded-md border border-danger-line bg-danger-soft/40 px-4 py-3 text-[13px]" role="alert">
        <p className="font-medium text-danger">有 {collisions.count} 個沒有保存在任何版本裡的項目擋住了回復</p>
        <p className="mt-0.5 text-ink-2">
          回復會覆寫或刪除它們，但它們不在任何版本裡，刪掉就找不回來，所以 Draft Tide
          不會動它們。把它們移到資料夾以外，或把它們加入保存範圍並保存版本，然後按「重新檢查」。
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {collisions.entries.map((c) => (
            <li key={c.path} className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[12px] text-ink" title={c.path}>
                {c.path}
              </span>
              <span className="text-[12px] text-ink-3">{COLLISION_COPY[c.reason]}</span>
            </li>
          ))}
          {collisions.count > collisions.entries.length && (
            <li className="text-[12px] text-ink-3">另外 {collisions.count - collisions.entries.length} 個…</li>
          )}
        </ul>
      </div>
    );
  }
  if (blocked === 'INSUFFICIENT_DISK_SPACE') {
    return (
      <div className="rounded-md border border-danger-line bg-danger-soft/40 px-4 py-3 text-[13px]" role="alert">
        <p className="font-medium text-danger">磁碟空間不足</p>
        <p className="mt-0.5 text-ink-2">
          回復需要寫入 {formatBytes(space.requiredBytes)}
          {space.availableBytes !== null && `，資料夾所在的磁碟只剩 ${formatBytes(space.availableBytes)}`}
          。清出空間後按「重新檢查」。
        </p>
      </div>
    );
  }
  if (blocked === 'RECOVERY_REQUIRED') {
    return (
      <div className="rounded-md border border-danger-line bg-danger-soft/40 px-4 py-3 text-[13px]" role="alert">
        <p className="font-medium text-danger">上一次的操作沒有完成</p>
        <p className="mt-0.5 text-ink-2">
          內容沒有遺失。關閉這個視窗，在專案頁的「需要恢復」區塊完成或還原它之後，再回復。
        </p>
      </div>
    );
  }
  const copy = errorCopy(blocked ?? 'INTERNAL_ERROR', {});
  return (
    <div className="rounded-md border border-danger-line bg-danger-soft/40 px-4 py-3 text-[13px]" role="alert">
      <p className="font-medium text-danger">{copy.title}</p>
      <p className="mt-0.5 text-ink-2">{copy.next}</p>
    </div>
  );
}
