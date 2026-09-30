import { useEffect, useState, type ReactNode } from 'react';
import { probeEngine, type EngineProbe } from '../bridge';
import { Alert, Bot, Check, ChevronLeft, Info, Spinner, Terminal } from '../components/Icons';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { MetaList } from '../components/ui/Details';
import { cn } from '../lib/cn';
import { formatBytes, formatWhen } from '../lib/format';
import { findVersion, historyBytes } from '../mock/engine';
import type { ProjectId } from '../mock/types';
import { useStore } from '../state/store';

const FREE_SPACE = 182_400_000_000;

export function SettingsScreen({ projectId }: { projectId?: ProjectId }) {
  const { state, navigate } = useStore();
  const back = () => navigate(projectId ? { name: 'project', projectId } : { name: 'start' });

  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-5 px-page pt-6 pb-24">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={back}>
            <ChevronLeft />
            返回
          </Button>
          <h1 className="text-[20px] font-semibold tracking-tight">設定與診斷</h1>
        </div>
        <div className="grid grid-cols-2 items-start gap-5">
          <div className="flex flex-col gap-5">
            <StorageCard />
            <PendingCard />
            <DiagnosticsCard />
          </div>
          <div className="flex flex-col gap-5">
            <EngineCard />
            <AgentCard projectName={state.projects.find((p) => p.id === projectId)?.name} />
            <VersionCard />
          </div>
        </div>
      </div>
    </div>
  );
}

function StorageCard() {
  const { state, dispatch, toast } = useStore();
  const history = state.projects.reduce((s, p) => s + historyBytes(p), 0);
  const staging = 0;
  const cache = state.cacheBytes;
  const total = history + staging + cache;
  const rows: Array<{ label: string; value: number; note: string; tone: string; action?: ReactNode }> = [
    { label: '版本歷史', value: history, note: `${state.projects.length} 個專案的所有版本；不會自動刪除`, tone: 'bg-tide-600' },
    { label: '暫存', value: staging, note: '沒有進行中的操作', tone: 'bg-protect' },
    {
      label: '快取',
      value: cache,
      note: '預覽與縮圖，可以重新產生',
      tone: 'bg-tide-200',
      action: (
        <Button
          size="sm"
          disabled={cache === 0}
          onClick={() => {
            dispatch({ type: 'clearCache' });
            toast({ tone: 'ok', title: '已清除快取', body: '預覽會在需要時重新產生；版本不受影響。' });
          }}
        >
          清除快取
        </Button>
      ),
    },
  ];
  return (
    <Card className="p-5">
      <SectionTitle className="mb-4">儲存空間</SectionTitle>
      <div className="mb-4 flex h-2.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.label} className={r.tone} style={{ width: `${total ? (r.value / total) * 100 : 0}%` }} />
        ))}
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3">
            <span className={cn('size-2.5 rounded-full', r.tone)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {r.label} <span className="font-normal text-ink-2">· {formatBytes(r.value)}</span>
              </p>
              <p className="text-[12px] text-ink-3">{r.note}</p>
            </div>
            {r.action}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[13px]">
        <span className="text-ink-2">這顆磁碟的可用空間</span>
        <span className="font-medium">{formatBytes(FREE_SPACE)}</span>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">空間不足時，可以清除快取、完成未完成的操作，或把備份存到其他磁碟。不需要自己整理 Git。</p>
    </Card>
  );
}

function PendingCard() {
  const { state, dispatch, navigate, toast } = useStore();
  return (
    <Card className="p-5">
      <SectionTitle className="mb-3">待你確認的操作</SectionTitle>
      {state.pending.length === 0 ? (
        <p className="text-[13px] text-ink-3">目前沒有等待確認的操作。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.pending.map((req) => {
            const project = state.projects.find((p) => p.id === req.projectId);
            const target = project ? findVersion(project, req.targetId) : undefined;
            return (
              <li key={req.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-agent" />
                  <p className="flex-1 text-[13px]">
                    <strong className="font-semibold">回復「{project?.name}」到 {target?.label}</strong>
                  </p>
                  <Badge tone="agent">經 {req.origin.toUpperCase()}</Badge>
                </div>
                <p className="mt-1 text-[12px] text-ink-3">
                  {req.callerLabel} · {formatWhen(req.requestedAt)}。名稱由請求方自行提供，僅供參考。
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => navigate({ name: 'restore', projectId: req.projectId, targetId: req.targetId, requestId: req.id })}
                  >
                    檢視並決定
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      dispatch({ type: 'removePending', id: req.id });
                      toast({ tone: 'info', title: '已拒絕請求', body: 'Agent 查詢時會看到「已拒絕」。' });
                    }}
                  >
                    拒絕
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DiagnosticsCard() {
  const { state, toast } = useStore();
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const missing = state.projects.filter((p) => !p.sourceAvailable);
  const checks: Array<{ ok: boolean; text: string }> = [
    { ok: true, text: '所有專案的版本歷史完整' },
    { ok: true, text: '沒有中斷、需要恢復的操作' },
    { ok: true, text: '本機狀態資料正常' },
    missing.length === 0
      ? { ok: true, text: '所有來源資料夾都可以讀取' }
      : { ok: false, text: `找不到 ${missing.length} 個專案的來源資料夾（${missing.map((p) => p.name).join('、')}）：可到專案中重新指定位置` },
  ];
  return (
    <Card className="p-5">
      <SectionTitle className="mb-3">診斷</SectionTitle>
      <p className="mb-3 text-[13px] text-ink-2">檢查版本歷史、未完成的操作與來源資料夾。只讀取，不會變更任何資料。</p>
      {phase === 'done' && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {checks.map((c) => (
            <li key={c.text} className="flex items-start gap-2 text-[13px]">
              {c.ok ? <Check className="mt-0.5 size-4 text-ok" /> : <Alert className="mt-0.5 size-4 text-warn" />}
              <span className={c.ok ? 'text-ink-2' : 'text-ink'}>{c.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={phase === 'running'}
          onClick={() => {
            setPhase('running');
            window.setTimeout(() => setPhase('done'), 900);
          }}
        >
          {phase === 'running' && <Spinner />}
          {phase === 'running' ? '檢查中…' : '執行檢查'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => toast({ tone: 'info', title: '（原型）已產生診斷報告', body: '報告已去識別化：不含設計內容、檔名或資料夾路徑。' })}
        >
          匯出診斷報告
        </Button>
      </div>
    </Card>
  );
}

function EngineCard() {
  const [probe, setProbe] = useState<EngineProbe>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    void probeEngine().then((p) => {
      if (alive) setProbe(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <SectionTitle>引擎狀態</SectionTitle>
        {probe.state === 'ok' && <Badge tone="ok">已連接</Badge>}
        {probe.state === 'web' && <Badge tone="outline">Web 原型</Badge>}
        {probe.state === 'error' && <Badge tone="danger">無法取得</Badge>}
      </div>
      {probe.state === 'loading' && (
        <p className="flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner />
          正在連接…
        </p>
      )}
      {probe.state === 'web' && (
        <div className="text-[13px] text-ink-2">
          <p className="font-medium text-ink">Web 原型（範例資料）</p>
          <p className="mt-1">沒有連接本機引擎。畫面上的專案、版本與檔案都是範例，不會讀取或寫入你電腦上的任何檔案。</p>
        </div>
      )}
      {probe.state === 'ok' && (
        <>
          <p className="mb-3 text-[13px] text-ink-2">已連接本機引擎。畫面上的專案資料仍是範例資料。</p>
          <MetaList
            rows={[
              ['Instance', probe.info.instanceId],
              ['PID', String(probe.info.pid)],
              ['Protocol', String(probe.info.protocolVersion)],
              ['Node', probe.info.nodeVersion],
              ['SQLite', probe.info.sqliteVersion],
              ['Git', probe.info.gitVersion],
              ['Git 路徑', probe.info.gitPath],
              ['資料位置', probe.info.dataDir],
            ]}
          />
        </>
      )}
      {probe.state === 'error' && (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {probe.message}
        </p>
      )}
    </Card>
  );
}

function AgentCard({ projectName }: { projectName: string | undefined }) {
  const [enabled, setEnabled] = useState(false);
  const rows: Array<{ icon: ReactNode; name: string; desc: string }> = [
    { icon: <Terminal />, name: 'CLI', desc: '讓腳本或 Agent 用指令查詢、保存與比較' },
    { icon: <Bot />, name: 'MCP', desc: '讓支援 MCP 的 Agent 直接呼叫 Draft Tide 的工具' },
    { icon: <Info />, name: 'Skill', desc: '教 Agent 正確使用 Draft Tide 的說明檔' },
  ];
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <SectionTitle>Agent 存取</SectionTitle>
        <Badge tone="outline">可選</Badge>
      </div>
      <p className="mb-4 text-[13px] text-ink-2">
        手動使用不需要這些設定。啟用後，外部 Agent 可以查詢、保存與比較；回復等會變更檔案的操作，仍需要你在 Draft Tide 裡確認。
      </p>
      <ul className="mb-4 flex flex-col divide-y divide-line rounded-lg border border-line">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-3 px-3 py-2.5">
            <span className="text-ink-3">{r.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {r.name} <Badge tone="neutral" className="ml-1">可選</Badge>
              </p>
              <p className="text-[12px] text-ink-3">{r.desc}</p>
            </div>
            <span className="text-[12px] text-ink-3">未設定</span>
          </li>
        ))}
      </ul>
      {projectName && (
        <label className="flex items-center gap-3 text-[13px]">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((e) => !e)}
            className={cn('relative h-5 w-9 rounded-full transition-colors', enabled ? 'bg-tide-600' : 'bg-line-strong')}
          >
            <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow-card transition-all', enabled ? 'left-[18px]' : 'left-0.5')} />
          </button>
          <span className="flex-1">允許 Agent 存取「{projectName}」</span>
          <span className="text-[11px] text-ink-3">原型：不會真的開放</span>
        </label>
      )}
    </Card>
  );
}

function VersionCard() {
  return (
    <Card className="p-5">
      <SectionTitle className="mb-3">版本資訊</SectionTitle>
      <MetaList
        rows={[
          ['Draft Tide', '0.0.0-m0（GUI 原型）'],
          ['介面模式', import.meta.env.MODE],
          ['預覽', '1280 × 800 · 不執行腳本 · 不連網'],
          ['歷史格式', 'v1（示意）'],
        ]}
      />
    </Card>
  );
}
