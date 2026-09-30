import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DesignFrame } from '../components/DesignFrame';
import { ChangeBadge } from '../components/FileChangeList';
import { Alert, ArrowRight, Bot, Check, ChevronLeft, Info, Restore, Save, Shield, Spinner } from '../components/Icons';
import { SourceBadge } from '../components/SourceBadge';
import { versionTitle } from '../components/VersionCard';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { Details, MetaList } from '../components/ui/Details';
import { Dialog } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import { formatBytes, formatWhen } from '../lib/format';
import { findVersion, latestVersion, planRestore, runRestore, type RestoreOutcome, type RestoreProgress } from '../mock/engine';
import type { FileChange, OperationStatus, Project, ProjectId, RestorePlan, SnapshotId, Version } from '../mock/types';
import { useProjectActions } from '../state/actions';
import { useProject, useStore } from '../state/store';

interface RestoreResult {
  target: Version;
  restore: Version;
  protection: Version | null;
  reused: Version | null;
}

export function RestoreScreen({ projectId, targetId, requestId }: { projectId: ProjectId; targetId: SnapshotId; requestId?: string }) {
  const project = useProject(projectId);
  const { state, navigate, dispatch, toast, markStep } = useStore();
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [replanTick, setReplanTick] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [staleDemo, setStaleDemo] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const actions = useProjectActions();
  const request = requestId ? state.pending.find((p) => p.id === requestId) : undefined;

  // A plan is a snapshot taken at "check" time. It deliberately does NOT
  // follow later folder changes — that is what makes PLAN_STALE detectable.
  useEffect(() => {
    if (project) setPlan(planRestore(project, targetId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replanTick, targetId]);

  useEffect(() => {
    if (result) markStep(7);
  }, [result, markStep]);

  if (!project) return null;
  const target = findVersion(project, targetId);
  if (!target) return null;
  const replan = () => setReplanTick((t) => t + 1);

  if (result) return <RestoreResultView project={project} result={result} />;

  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="flex flex-col gap-5 px-page pt-6 pb-24">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'project', projectId })}>
            <ChevronLeft />
            版本歷史
          </Button>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">
              回復到 {target.label}「{versionTitle(target)}」
            </h1>
            <p className="text-[13px] text-ink-2">先看看回復會改變什麼。確認之前，任何檔案都不會被變更。</p>
          </div>
        </div>

        {request && (
          <div className="flex items-center gap-3 rounded-lg border border-agent/25 bg-agent-soft px-4 py-3">
            <Bot className="size-4 text-agent" />
            <p className="flex-1 text-[13px]">
              <strong className="font-semibold">這個回復是外部 Agent 經 {request.origin.toUpperCase()} 請求的。</strong>
              <span className="text-ink-2"> 只有你在這裡確認後才會執行；Agent 只能查詢結果，無法自行批准。</span>
            </p>
            <Button
              size="sm"
              onClick={() => {
                dispatch({ type: 'removePending', id: request.id });
                toast({ tone: 'info', title: '已拒絕 Agent 的回復請求', body: 'Agent 查詢時會看到「已拒絕」。沒有任何檔案被變更。' });
                navigate({ name: 'project', projectId });
              }}
            >
              拒絕請求
            </Button>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-6">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
              <Card className="p-3">
                <p className="mb-2 px-1 text-[12px] font-medium text-ink-2">目前資料夾</p>
                <DesignFrame files={project.working} entry={project.entry} title="目前資料夾預覽" />
              </Card>
              <ArrowRight className="size-5 text-ink-3" />
              <Card className="border-tide-200 p-3">
                <p className="mb-2 px-1 text-[12px] font-medium text-tide-700">回復後（與 {target.label} 相同）</p>
                <DesignFrame files={target.files} entry={project.entry} title={`${target.label} 預覽`} status={target.previewStatus} />
              </Card>
            </div>
            <HistoryStrip project={project} target={target} plan={plan} />
            <DemoControls
              staleDemo={staleDemo}
              onStaleDemo={setStaleDemo}
              onUntracked={() => {
                // Simulate an external tool creating a never-saved file, then re-check.
                actions.addUntracked(projectId);
                replan();
              }}
            />
          </div>

          <PlanSummary
            project={project}
            target={target}
            plan={plan}
            onConfirm={() => setConfirmOpen(true)}
            onReplan={replan}
            actions={actions}
          />
        </div>
      </div>

      {plan && (
        <ConfirmAndRun
          open={confirmOpen}
          project={project}
          target={target}
          plan={plan}
          staleDemo={staleDemo}
          onClose={() => setConfirmOpen(false)}
          onReplan={() => {
            setConfirmOpen(false);
            setStaleDemo(false);
            replan();
          }}
          onDone={(r) => {
            setConfirmOpen(false);
            if (request) dispatch({ type: 'removePending', id: request.id });
            setResult(r);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FileGroup({ label, changes, tone }: { label: string; changes: FileChange[]; tone: 'modified' | 'added' | 'deleted' }) {
  if (changes.length === 0) {
    return (
      <div className="flex items-center gap-3 py-1.5 text-[13px] text-ink-3">
        <ChangeBadge status={tone} />
        {label} 0 個檔案
      </div>
    );
  }
  return (
    <Details
      summary={
        <span className="flex items-center gap-3 text-[13px] text-ink">
          <ChangeBadge status={tone} />
          <span>
            {label} <strong>{changes.length}</strong> 個檔案
          </span>
        </span>
      }
      summaryClassName="py-1.5"
    >
      <ul className="mb-1 ml-6 flex flex-col gap-1 rounded-md bg-raised px-3 py-2">
        {changes.map((c) => (
          <li key={c.path} className="flex items-center gap-2 text-[12px]">
            <span className="flex-1 truncate font-mono text-ink-2">{c.path}</span>
            <span className="text-ink-3">{formatBytes((c.after ?? c.before)?.size ?? 0)}</span>
          </li>
        ))}
      </ul>
    </Details>
  );
}

function PlanSummary({
  project,
  target,
  plan,
  onConfirm,
  onReplan,
  actions,
}: {
  project: Project;
  target: Version;
  plan: RestorePlan | null;
  onConfirm: () => void;
  onReplan: () => void;
  actions: ReturnType<typeof useProjectActions>;
}) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  // Describe the plan as it was made, not the live history (which changes once the restore commits).
  const head = plan ? findVersion(project, plan.baseHead) : latestVersion(project);

  if (!plan) {
    return (
      <Card className="flex items-center gap-2 p-5 text-sm text-ink-2">
        <Spinner />
        正在檢查回復內容…
      </Card>
    );
  }

  const total = plan.overwrite.length + plan.add.length + plan.remove.length;
  const blocked = plan.untracked.length > 0;
  const nothingToDo = total === 0;

  return (
    <Card className="sticky top-6 flex flex-col gap-4 p-5">
      <SectionTitle>回復會做這些事</SectionTitle>

      <div className="flex flex-col">
        <FileGroup label="覆寫" changes={plan.overwrite} tone="modified" />
        <FileGroup label="新增" changes={plan.add} tone="added" />
        <FileGroup label="刪除" changes={plan.remove} tone="deleted" />
      </div>

      {blocked ? (
        <div className="rounded-lg border border-danger-line bg-danger-soft p-4" role="alert">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-danger">
            <Alert />
            有未保存的新檔案會被刪除
          </p>
          <p className="mt-1.5 text-[13px] text-ink-2">
            下列檔案從來沒有被保存過。{target.label} 裡沒有它們，回復後就找不回來，所以先暫停。
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {plan.untracked.map((f) => (
              <li key={f.path} className="font-mono text-[12px] text-ink">
                {f.path}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              variant="primary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const r = await actions.saveVersion(project.id, '回復前先保存的內容');
                setSaving(false);
                if (r.ok) toast({ tone: 'ok', title: `已保存 ${r.version.label}`, body: '新檔案已在歷史中，可以安全地重新檢查回復內容。' });
                onReplan();
              }}
            >
              {saving ? <Spinner /> : <Save />}
              先保存目前內容
            </Button>
            <Button
              onClick={() => {
                actions.removeUntracked(
                  project.id,
                  plan.untracked.map((f) => f.path),
                );
                onReplan();
              }}
            >
              我已移走該檔案，重新檢查
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">原型：第二個按鈕會模擬你已把檔案移到別處。</p>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg bg-protect-soft/70 px-3.5 py-3 text-[13px] text-ink-2">
          <Shield className="mt-0.5 size-4 text-protect" />
          {plan.unsaved.length > 0 ? (
            <p>
              目前有 <strong className="text-ink">{plan.unsaved.length} 個檔案尚未保存</strong>，會先保存為「回復前保護版本」，之後隨時可以回到它。
            </p>
          ) : (
            <p>
              目前內容已保存在 {head?.label}，不需要另外保存；之後仍可回到 {head?.label}。
            </p>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-1.5 text-[12px] text-ink-2">
        <li className="flex gap-2">
          <Check className="mt-0.5 size-3.5 text-ok" />
          只變更保存範圍內的檔案；範圍外的檔案（例如 node_modules、.env.local）不會被刪除或修改。
        </li>
        <li className="flex gap-2">
          <Check className="mt-0.5 size-3.5 text-ok" />
          不會改動資料夾原有的 .git。
        </li>
        <li className="flex gap-2">
          <Check className="mt-0.5 size-3.5 text-ok" />
          回復會新增一個版本，不會刪除任何歷史。
        </li>
      </ul>

      {nothingToDo && !blocked ? (
        <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">資料夾內容已經和 {target.label} 相同，不需要回復。</p>
      ) : null}

      <Button variant="primary" size="lg" disabled={blocked || nothingToDo || !project.sourceAvailable} onClick={onConfirm}>
        <Restore />
        回復到 {target.label}…
      </Button>

      <Details summary="詳細資訊">
        <MetaList
          rows={[
            ['計畫 ID', plan.planId],
            ['目標版本 ID', plan.targetId],
            ['目前最新版本 ID', plan.baseHead],
            ['資料夾指紋', plan.fingerprint.slice(0, 16)],
            ['有效期限', new Date(plan.expiresAt).toLocaleTimeString('zh-TW', { hour12: false })],
          ]}
        />
        <p className="mt-2 text-[11px] text-ink-3">計畫 ID 只用來識別這份計畫，不代表已批准；確認只能在這個視窗完成。</p>
      </Details>
    </Card>
  );
}

function HistoryStrip({ project, target, plan }: { project: Project; target: Version; plan: RestorePlan | null }) {
  const needsProtection = (plan?.unsaved.length ?? 0) > 0 && (plan?.untracked.length ?? 0) === 0;
  const baseIdx = plan ? project.versions.findIndex((v) => v.meta.snapshotId === plan.baseHead) : -1;
  const versions = baseIdx >= 0 ? project.versions.slice(0, baseIdx + 1) : project.versions;
  const n = versions.length;
  return (
    <Card className="px-4 py-3">
      <p className="mb-2 text-[12px] font-medium text-ink-2">回復後的版本歷史</p>
      <ol className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {versions.map((v) => (
          <li key={v.meta.snapshotId} className="flex items-center gap-1.5">
            <span
              className={cn(
                'rounded-sm px-1.5 py-0.5 font-medium',
                v.meta.snapshotId === target.meta.snapshotId ? 'bg-tide-100 text-tide-700' : 'bg-sunken text-ink-2',
              )}
            >
              {v.label}
            </span>
            <span className="text-ink-3">→</span>
          </li>
        ))}
        {needsProtection && (
          <li className="flex items-center gap-1.5">
            <span className="rounded-sm border border-dashed border-protect/50 bg-protect-soft px-1.5 py-0.5 font-medium text-protect">
              V{n + 1} 保護
            </span>
            <span className="text-ink-3">→</span>
          </li>
        )}
        <li>
          <span className="rounded-sm border border-dashed border-restore/50 bg-restore-soft px-1.5 py-0.5 font-medium text-restore">
            V{n + (needsProtection ? 2 : 1)} 回復（內容 = {target.label}）
          </span>
        </li>
      </ol>
    </Card>
  );
}

function DemoControls({
  staleDemo,
  onStaleDemo,
  onUntracked,
}: {
  staleDemo: boolean;
  onStaleDemo: (v: boolean) => void;
  onUntracked: () => void;
}) {
  return (
    <div className="dt-demo flex flex-col gap-2 rounded-lg px-4 py-3">
      <p className="text-[11px] font-medium tracking-wide text-ink-3">原型示範（主持人用）</p>
      <label className="flex items-start gap-2 text-[13px] text-ink-2">
        <input type="checkbox" checked={staleDemo} onChange={(e) => onStaleDemo(e.target.checked)} className="mt-1 accent-tide-600" />
        <span>確認後，模擬其他工具在寫回前修改了 styles.css（計畫過期）</span>
      </label>
      <div>
        <Button variant="demo" size="sm" onClick={onUntracked}>
          模擬其他工具新增了一個從未保存的檔案
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const STAGES: Array<{ label: string; statuses: OperationStatus[] }> = [
  { label: '準備', statuses: ['confirmed', 'preflight'] },
  { label: '保護目前內容', statuses: ['protected'] },
  { label: '寫回檔案', statuses: ['staged', 'applying'] },
  { label: '驗證', statuses: ['verified'] },
  { label: '完成', statuses: ['committed', 'completed'] },
];

function stageIndex(status: OperationStatus): number {
  return STAGES.findIndex((s) => s.statuses.includes(status));
}

type Phase =
  | { kind: 'confirm' }
  | { kind: 'running'; progress: RestoreProgress }
  | { kind: 'stale'; changed: string[] }
  | { kind: 'done'; result: RestoreResult };

function ConfirmAndRun({
  open,
  project,
  target,
  plan,
  staleDemo,
  onClose,
  onReplan,
  onDone,
}: {
  open: boolean;
  project: Project;
  target: Version;
  plan: RestorePlan;
  staleDemo: boolean;
  onClose: () => void;
  onReplan: () => void;
  onDone: (r: RestoreResult) => void;
}) {
  const { getProject, toast, markStep } = useStore();
  const { appendVersions, externalTouch } = useProjectActions();
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });
  const [writersStopped, setWritersStopped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resultBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setPhase({ kind: 'confirm' });
      setWritersStopped(false);
    }
  }, [open]);

  useEffect(() => {
    if (phase.kind === 'done') resultBtn.current?.focus();
  }, [phase.kind]);

  const start = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: 'running', progress: { status: 'confirmed' } });
    if (staleDemo) externalTouch(project.id);
    let outcome: RestoreOutcome;
    try {
      outcome = await runRestore(
        () => getProject(project.id),
        plan,
        (progress) =>
          // Merge events so earlier facts (e.g. which protection version was made) stay visible.
          setPhase((prev) => ({ kind: 'running', progress: { ...(prev.kind === 'running' ? prev.progress : {}), ...progress } })),
        ctrl.signal,
      );
    } catch {
      setPhase({ kind: 'confirm' });
      toast({ tone: 'warn', title: '回復沒有完成', body: '請到「設定與診斷」查看恢復步驟。' });
      return;
    }
    if (outcome.ok) {
      const added = outcome.protection ? [outcome.protection, outcome.restore] : [outcome.restore];
      appendVersions(project.id, added, { working: target.files, workingDesign: target.design });
      markStep(6);
      setPhase({
        kind: 'done',
        result: { target, restore: outcome.restore, protection: outcome.protection, reused: outcome.reusedProtection },
      });
    } else if (outcome.code === 'PLAN_STALE') {
      setPhase({ kind: 'stale', changed: outcome.changed });
    } else {
      onClose();
      toast({ tone: 'info', title: '已取消回復', body: '沒有任何檔案被變更。' });
    }
  };

  const running = phase.kind === 'running';
  const cancellable = running && (phase.progress.status === 'confirmed' || phase.progress.status === 'preflight');
  const dismissible = phase.kind === 'confirm' || phase.kind === 'stale';

  let title: ReactNode = `回復到 ${target.label}「${versionTitle(target)}」？`;
  if (running) title = `正在回復到 ${target.label}`;
  if (phase.kind === 'stale') title = '檔案已改變，請重新檢查回復內容';
  if (phase.kind === 'done') title = `已回復到 ${target.label}`;

  let footer: ReactNode;
  if (phase.kind === 'confirm') {
    footer = (
      <>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!writersStopped} onClick={() => void start()}>
          <Restore />
          回復到此版
        </Button>
      </>
    );
  } else if (running) {
    footer = (
      <>
        <span className="mr-auto text-[12px] text-ink-3">
          {cancellable ? '寫回開始前可以取消。' : '正在保護與寫回，完成驗證前請不要關閉 Draft Tide。'}
        </span>
        <Button disabled={!cancellable} onClick={() => abortRef.current?.abort()}>
          取消
        </Button>
      </>
    );
  } else if (phase.kind === 'stale') {
    footer = (
      <>
        <Button onClick={onClose}>關閉</Button>
        <Button variant="primary" onClick={onReplan} data-autofocus>
          重新檢查
        </Button>
      </>
    );
  } else {
    footer = (
      <Button ref={resultBtn} variant="primary" onClick={() => onDone(phase.result)}>
        查看結果
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (dismissible) onClose();
      }}
      dismissible={dismissible}
      title={title}
      tone={phase.kind === 'stale' ? 'warn' : 'default'}
      footer={footer}
    >
      {phase.kind === 'confirm' && (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-1.5 rounded-lg bg-raised px-4 py-3 text-[13px] text-ink-2">
            <li>
              覆寫 <strong className="text-ink">{plan.overwrite.length}</strong> 個、新增 <strong className="text-ink">{plan.add.length}</strong> 個、刪除{' '}
              <strong className="text-ink">{plan.remove.length}</strong> 個檔案
            </li>
            <li>
              {plan.unsaved.length > 0
                ? `目前 ${plan.unsaved.length} 個尚未保存的檔案會先保存為「回復前保護版本」`
                : '目前內容已經保存過，不需要另外保存'}
            </li>
            <li>保存範圍以外的檔案不會被刪除或修改</li>
          </ul>
          <label className="flex items-start gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              data-autofocus
              checked={writersStopped}
              onChange={(e) => setWritersStopped(e.target.checked)}
              className="mt-0.5 size-4 accent-tide-600"
            />
            <span>
              我已關閉或暫停會寫入這個資料夾的工具（例如編輯器的自動儲存、正在執行的 Agent）。
              <span className="mt-0.5 block text-[12px] text-ink-3">Draft Tide 無法鎖住其他程式；回復期間若有檔案被改動，會停下來請你重新檢查。</span>
            </span>
          </label>
        </div>
      )}

      {running && <ProgressStages progress={phase.progress} target={target} plan={plan} />}

      {phase.kind === 'stale' && (
        <div className="flex flex-col gap-3 text-[13px] text-ink-2">
          <p>
            在你確認之後，資料夾裡有檔案被其他工具修改了。為了不覆寫新的修改，<strong className="text-ink">這次回復沒有執行，任何檔案都沒有變更。</strong>
          </p>
          {phase.changed.length > 0 && (
            <div className="rounded-md bg-warn-soft px-3 py-2">
              <p className="text-[12px] text-warn">有變動的檔案</p>
              <ul className="mt-1 font-mono text-[12px] text-ink">
                {phase.changed.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <p>請先確認其他工具已停止寫入，再按「重新檢查」產生新的回復內容。</p>
          <p className="text-[11px] text-ink-3">錯誤代碼：PLAN_STALE</p>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="flex flex-col gap-4">
          <ProgressStages progress={{ status: 'completed' }} target={target} plan={plan} result={phase.result} />
          <p className="flex items-start gap-2 rounded-lg bg-ok-soft px-4 py-3 text-[13px] text-ink-2" role="status">
            <Check className="mt-0.5 size-4 text-ok" />
            資料夾內容已驗證與 {target.label} 相同，並保存為新的 {phase.result.restore.label}「回復版本」。
          </p>
        </div>
      )}
    </Dialog>
  );
}

function ProgressStages({
  progress,
  target,
  plan,
  result,
}: {
  progress: RestoreProgress;
  target: Version;
  plan: RestorePlan;
  result?: RestoreResult;
}) {
  const current = stageIndex(progress.status);
  const completed = progress.status === 'completed';
  const created = result?.protection ?? (progress.protection && 'created' in progress.protection ? progress.protection.created : null);
  const reused = result?.reused ?? (progress.protection && 'reused' in progress.protection ? progress.protection.reused : null);
  const protectText = created
    ? `已保存為 ${created.label}「回復前保護版本」`
    : reused
      ? `目前內容已在 ${reused.label}，不需另存`
      : plan.unsaved.length > 0
        ? '保存尚未保存的修改'
        : '確認目前內容已在歷史中';

  const total = plan.overwrite.length + plan.add.length + plan.remove.length;
  const details = [
    '核對檔案、空間與權限',
    protectText,
    progress.status === 'applying' ? `${progress.filesDone ?? 0} / ${progress.filesTotal ?? total} 個檔案` : `${total} 個檔案`,
    `確認資料夾內容與 ${target.label} 完全相同`,
    result ? `已建立 ${result.restore.label}「回復版本」` : '建立回復版本',
  ];

  return (
    <ol className="flex flex-col gap-0.5" aria-label="回復進度">
      {STAGES.map((s, i) => {
        const done = i < current || (completed && i === current);
        const active = i === current && !completed;
        return (
          <li key={s.label} className="flex items-center gap-3 py-1.5" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                done && 'bg-tide-600 text-white',
                active && 'bg-tide-100 text-tide-700',
                !done && !active && 'border border-line-strong text-ink-3',
              )}
            >
              {done ? <Check className="size-3.5" /> : active ? <Spinner /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[14px]', done || active ? 'font-medium text-ink' : 'text-ink-3')}>{s.label}</span>
              {(done || active) && <span className="block text-[12px] text-ink-3">{details[i]}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------

function RestoreResultView({ project, result }: { project: Project; result: RestoreResult }) {
  const { navigate } = useStore();
  // Re-read versions from the store so preview status stays live.
  const live_ = (v: Version | null) => (v ? (findVersion(project, v.meta.snapshotId) ?? v) : null);
  const restore = live_(result.restore) ?? result.restore;
  const protection = live_(result.protection);
  const reused = live_(result.reused);
  const target = live_(result.target) ?? result.target;
  const newIds = new Set([restore.meta.snapshotId, protection?.meta.snapshotId].filter(Boolean));
  const live = project.versions.map((v) => v);
  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-6 px-page pt-8 pb-24">
        <div className="flex items-start gap-4 rounded-xl border border-ok/25 bg-ok-soft px-5 py-4" role="status">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-ok text-white">
            <Check className="size-5" />
          </span>
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold">已回復到 {target.label}「{versionTitle(target)}」</h1>
            <p className="mt-0.5 text-[13px] text-ink-2">
              資料夾內容已驗證與 {target.label} 相同，並保存為新的 {restore.label}。之前的版本都還在，沒有任何歷史被刪除。
            </p>
          </div>
        </div>

        <Card className="px-5 py-4">
          <SectionTitle className="mb-3">版本歷史</SectionTitle>
          <ol className="flex items-end gap-2 overflow-x-auto pb-1">
            {live.map((v, i) => (
              <li key={v.meta.snapshotId} className="flex items-end gap-2">
                <div className={cn('w-[120px] shrink-0', !newIds.has(v.meta.snapshotId) && 'opacity-80')}>
                  <DesignFrame files={v.files} entry={project.entry} title={`${v.label} 縮圖`} status={v.previewStatus} />
                  <div className="mt-1.5 flex items-center gap-1">
                    <span className={cn('text-[12px] font-semibold', newIds.has(v.meta.snapshotId) ? 'text-ink' : 'text-ink-3')}>{v.label}</span>
                    {newIds.has(v.meta.snapshotId) && (
                      <Badge tone={v.meta.kind === 'restore' ? 'restore' : 'protect'} className="h-[18px] px-1.5 text-[11px]">
                        新
                      </Badge>
                    )}
                  </div>
                </div>
                {i < live.length - 1 && <span className="pb-8 text-ink-3">→</span>}
              </li>
            ))}
          </ol>
        </Card>

        <div className="grid grid-cols-2 gap-4">
          <ResultCard
            project={project}
            version={restore}
            text={`內容與 ${target.label} 相同。你的編輯器現在看到的就是這個版本。`}
            action={
              <Button variant="primary" onClick={() => navigate({ name: 'project', projectId: project.id, focus: restore.meta.snapshotId })}>
                在版本歷史查看
              </Button>
            }
          />
          {protection ? (
            <ResultCard
              project={project}
              version={protection}
              text="回復前尚未保存的修改都在這裡。想改回去，可以回復到這個版本。"
              action={
                <Button onClick={() => navigate({ name: 'project', projectId: project.id, focus: protection.meta.snapshotId })}>
                  <Shield />
                  查看回復前保護版本
                </Button>
              }
            />
          ) : (
            <Card className="flex flex-col justify-center gap-2 p-5 text-[13px] text-ink-2">
              <p className="flex items-center gap-2 font-medium text-ink">
                <Shield className="text-protect" />
                不需要另外保護
              </p>
              <p>回復前的內容已經保存在 {reused?.label}「{reused ? versionTitle(reused) : ''}」，隨時可以回到它。</p>
              {reused && (
                <div>
                  <Button size="sm" onClick={() => navigate({ name: 'project', projectId: project.id, focus: reused.meta.snapshotId })}>
                    查看 {reused.label}
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>

        <p className="flex items-start gap-2 text-[13px] text-ink-2">
          <Info className="mt-0.5 size-4 text-tide-600" />
          可以回到你的編輯器繼續工作了。若編輯器仍顯示舊內容，請在編輯器重新載入檔案；這不代表回復失敗。
        </p>
      </div>
    </div>
  );
}

function ResultCard({ project, version, text, action }: { project: Project; version: Version; text: string; action: ReactNode }) {
  return (
    <Card className="flex gap-4 p-4">
      <div className="w-[180px] shrink-0">
        <DesignFrame files={version.files} entry={project.entry} title={`${version.label} 縮圖`} status={version.previewStatus} />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink-3">{version.label}</span>
          <SourceBadge kind={version.meta.kind} />
        </div>
        <p className="text-[15px] font-semibold">{versionTitle(version)}</p>
        <p className="text-[12px] text-ink-3">{formatWhen(version.meta.createdAt)}</p>
        <p className="text-[13px] text-ink-2">{text}</p>
        <div className="mt-auto">{action}</div>
      </div>
    </Card>
  );
}
