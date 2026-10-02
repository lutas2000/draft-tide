import { useId, useState } from 'react';
import {
  DtError,
  type HistoryEntry,
  type ProjectId,
  type RecoveryItem,
  type RecoveryPlan,
  type RecoveryResult,
  type RecoveryStrategy,
} from '@draft-tide/contracts';
import { Alert } from '../components/icons.tsx';
import { ProgressLine } from '../components/progress.tsx';
import { ConfirmDialog } from '../components/ui/alert-dialog.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { ORIGIN_LABEL, RECOVERY_REASON_COPY } from '../lib/copy.ts';
import { useOperationProgress, useRecoveryApply, useRecoveryPlan, useRecoveryReport } from '../lib/engine-state.ts';
import { formatWhen, refLabel } from '../lib/format.ts';
import { ErrorNote } from './error-note.tsx';

// 中斷恢復 (M1 plan §4.1, §9.4): an operation stopped part-way. Each item says
// what it was, why it stopped and where its files are, and offers what the
// Engine can do: finish it or put the files back. Files another program
// changed are always left as they are. Items Draft Tide completes by itself
// before the next change can also be completed here.

export interface Recovered {
  item: RecoveryItem;
  strategy: RecoveryStrategy;
  result: RecoveryResult;
}

interface Action {
  strategy: RecoveryStrategy;
  label: string;
  title: string;
}

function actionsFor(item: RecoveryItem): Action[] {
  if (item.automatic) {
    const strategy = item.strategies.includes('finish') ? 'finish' : item.strategies[0];
    return strategy ? [{ strategy, label: '完成', title: '完成這個步驟？' }] : [];
  }
  return item.strategies.map((strategy): Action => {
    if (strategy === 'finish') {
      return item.kind === 'restore'
        ? { strategy, label: '完成回復', title: '完成回復？' }
        : { strategy, label: '完成', title: '完成這個操作？' };
    }
    if (item.kind === 'lock') {
      return { strategy, label: '移除 Draft Tide 留下的鎖', title: '移除 Draft Tide 留下的鎖？' };
    }
    return item.kind === 'restore'
      ? { strategy, label: '還原成回復前的內容', title: '還原成回復前的內容？' }
      : { strategy, label: '還原', title: '還原這個操作？' };
  });
}

function itemTitle(item: RecoveryItem, entries: readonly HistoryEntry[]): string {
  if (item.kind === 'lock') return 'Draft Tide 留下的鎖（.git/index.lock）';
  if (item.kind === 'save') return '保存版本';
  return item.target ? `回復到 ${refLabel(entries, item.target)}` : '回復版本';
}

export function RecoveryCard({
  projectId,
  entries,
  onRecovered,
}: {
  projectId: ProjectId;
  entries: readonly HistoryEntry[];
  onRecovered: (outcome: Recovered) => void;
}) {
  const report = useRecoveryReport(projectId, true);
  const plan = useRecoveryPlan(projectId);
  const apply = useRecoveryApply(projectId);
  const progress = useOperationProgress(projectId);
  const [confirming, setConfirming] = useState<{ item: RecoveryItem; action: Action; plan: RecoveryPlan } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const titleId = useId();

  const items = report.data?.items ?? [];
  const deciding = items.some((i) => !i.automatic);
  const lockNote =
    report.data?.lock === 'draft-tide' || items.some((i) => i.kind === 'lock' || i.reason === 'index-switch');
  const stale = error instanceof DtError && error.code === 'PLAN_STALE';

  const start = async (item: RecoveryItem, action: Action) => {
    setError(null);
    try {
      const p = await plan.mutateAsync({ operationId: item.operationId, strategy: action.strategy });
      setConfirming({ item, action, plan: p });
    } catch (e) {
      setError(e);
      void report.refetch();
    }
  };

  const confirm = async () => {
    if (!confirming) return;
    const { item, plan: p } = confirming;
    try {
      const result = await apply.mutateAsync(p.planId);
      setConfirming(null);
      onRecovered({ item, strategy: p.strategy, result });
    } catch (e) {
      // PLAN_STALE: the card shows what is true now (re-inspected).
      setConfirming(null);
      setError(e);
      void report.refetch();
    }
  };

  return (
    <Card className="border-warn-line px-5 py-4" aria-labelledby={titleId}>
      <div className="flex items-start gap-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
          <Alert />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[15px] font-semibold">
            需要恢復
          </h2>
          <p className="text-[13px] text-ink-2">
            {deciding
              ? '上一次的操作在途中停止了，內容沒有遺失。選擇要完成它，或還原成操作之前的內容；處理之前無法保存或回復。'
              : '上一次的操作有一個步驟沒有完成。Draft Tide 會在下一次保存或回復之前自動完成它，也可以現在完成。'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {report.isPending ? (
          <p className="text-[13px] text-ink-3" role="status">
            檢查未完成的操作…
          </p>
        ) : report.isError ? (
          <ErrorNote error={report.error} />
        ) : items.length === 0 ? (
          <p className="text-[13px] text-ink-3">已經沒有需要處理的項目。</p>
        ) : (
          items.map((item) => (
            <ItemRow
              key={item.operationId}
              item={item}
              entries={entries}
              busy={plan.isPending || apply.isPending}
              onAction={(action) => void start(item, action)}
            />
          ))
        )}
        {lockNote && (
          <p className="flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <Alert className="mt-0.5 size-4 shrink-0" />
            請勿手動刪除 .git/index.lock：它讓其他 Git 工具在恢復完成之前，不會把舊的內容記錄進歷史。
          </p>
        )}
        {stale ? (
          <p className="rounded-md bg-raised px-3 py-2 text-[13px] text-ink-2" role="status">
            檔案在檢查之後有變動，上面是重新檢查的結果。請再選擇一次。
          </p>
        ) : (
          error !== null && <ErrorNote error={error} />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !apply.isPending) setConfirming(null);
        }}
        title={confirming?.action.title ?? ''}
        confirmLabel={apply.isPending ? '處理中…' : (confirming?.action.label ?? '')}
        busy={apply.isPending}
        onConfirm={() => void confirm()}
      >
        {confirming && <PlanSummary item={confirming.item} plan={confirming.plan} />}
        {apply.isPending && (
          <div className="mt-3">
            <ProgressLine event={progress?.operation === 'recovery.apply' ? progress : null} fallback="恢復中…" />
          </div>
        )}
      </ConfirmDialog>
    </Card>
  );
}

function ItemRow({
  item,
  entries,
  busy,
  onAction,
}: {
  item: RecoveryItem;
  entries: readonly HistoryEntry[];
  busy: boolean;
  onAction: (action: Action) => void;
}) {
  const reason = RECOVERY_REASON_COPY[item.reason];
  const files = item.files;
  const meta = [
    item.origin ? `經 ${ORIGIN_LABEL[item.origin]}` : null,
    item.startedAt ? formatWhen(item.startedAt) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3 text-[13px]">
      <p className="font-medium text-ink">{itemTitle(item, entries)}</p>
      {meta && <p className="text-[12px] text-ink-3">{meta}</p>}
      <p className="mt-2 text-ink">{reason.title}</p>
      <p className="text-ink-2">{reason.next}</p>
      {item.protection && (
        <p className="mt-1 text-ink-2">
          回復前的內容保存在 {refLabel(entries, item.protection)}（回復前保護），不會遺失。
        </p>
      )}
      {files && (
        <p className="mt-1 text-ink-2">
          {files.total} 個檔案：{files.done} 個已經是回復後的內容、{files.pending} 個還是回復前的內容
          {files.conflicts.count > 0 && `、${files.conflicts.count} 個被其他程式改過`}。
        </p>
      )}
      {files && files.conflicts.count > 0 && (
        <div className="mt-2 rounded-md bg-raised px-3 py-2">
          <p className="text-[12px] text-ink-2">
            其他程式改過的 {files.conflicts.count} 個檔案會保持原樣，不會被動到：
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {files.conflicts.sample.map((path) => (
              <li key={path} className="truncate font-mono text-[12px] text-ink-2" title={path}>
                {path}
              </li>
            ))}
            {files.conflicts.count > files.conflicts.sample.length && (
              <li className="text-[12px] text-ink-3">
                另外 {files.conflicts.count - files.conflicts.sample.length} 個…
              </li>
            )}
          </ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {actionsFor(item).map((action, i) => (
          <Button
            key={action.strategy}
            size="sm"
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => onAction(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// What applying the plan does, before the user confirms it.
function PlanSummary({ item, plan }: { item: RecoveryItem; plan: RecoveryPlan }) {
  const conflicts = plan.conflicts;
  return (
    <div className="flex flex-col gap-2">
      {item.files ? (
        <p>
          寫入 {plan.write} 個檔案、刪除 {plan.delete} 個、保持 {plan.unchanged} 個不變
          {conflicts.count > 0 ? `；其他程式改過的 ${conflicts.count} 個檔案不會被動到。` : '。'}
        </p>
      ) : item.kind === 'lock' && plan.strategy === 'rollback' ? (
        <p>
          只會移除 .git/index.lock 這個鎖，不會改動任何設計檔案或歷史。請先確認沒有其他 Draft Tide 正在使用這個資料夾。
        </p>
      ) : (
        <p>不會改動任何設計檔案。</p>
      )}
      {conflicts.count > 0 && (
        <p className="truncate font-mono text-[12px] text-ink-3" title={conflicts.sample.join('\n')}>
          {conflicts.sample.slice(0, 5).join('、')}
          {conflicts.count > 5 ? '…' : ''}
        </p>
      )}
      {plan.strategy === 'finish' && plan.records && item.kind === 'restore' && !item.automatic && (
        <p>完成之後，回復版本會記錄在歷史中。</p>
      )}
      {plan.strategy === 'rollback' && item.kind === 'restore' && <p>不會建立新的版本；回復前保護版本仍在歷史中。</p>}
    </div>
  );
}
