import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { OperationStatus, StorageUsage } from '@draft-tide/contracts';
import type { ConnectionState, DiagnosticsExport } from '../../shared/bridge.ts';
import { Agent, Alert, Check } from '../components/icons.tsx';
import {
  GitHubRequestBanner,
  isConnectRequest,
  isGitHubRequest,
  useAnswerRequest,
  type ConnectRequest,
} from '../components/operation-banners.tsx';
import { ConfirmDialog } from '../components/ui/alert-dialog.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { Details } from '../components/ui/details.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { ORIGIN_LABEL } from '../lib/copy.ts';
import {
  useAgentAccess,
  useDeclineRequest,
  useEngineInfo,
  useOperationList,
  useProjects,
  useSetAgentAccess,
} from '../lib/engine-state.ts';
import {
  EngineCallError,
  agentSetup,
  copyText,
  engineCall,
  exportDiagnostics,
  revealDiagnostics,
} from '../lib/bridge.ts';
import { formatBytes, formatWhen, shortId } from '../lib/format.ts';
import { usePreviewStatus, previewStatusKey } from '../lib/preview.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// The global agent-access switch (M1 plan §9.1). Turning it on is consent, so
// the dialog states the accepted risk before it happens. Turning it off needs
// no confirmation. The switch shows only what the Engine reports.
function AgentAccessCard() {
  const access = useAgentAccess();
  const setAccess = useSetAgentAccess();
  const [confirming, setConfirming] = useState(false);
  const enabled = access.data?.enabled ?? false;

  const change = (next: boolean) => {
    if (next) setConfirming(true);
    else setAccess.mutate(false);
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Agent className="size-4 text-agent" />
            允許 agent 存取（CLI 與 MCP）
          </span>
        }
        description="開啟後，外部 agent 可以透過命令列工具與 MCP 操作所有已連接的專案。CLI 與 MCP 一起開關。"
        action={
          <Switch
            aria-label="允許 agent 存取"
            checked={enabled}
            disabled={access.isPending || access.isError || setAccess.isPending}
            onCheckedChange={change}
          />
        }
      />
      <CardBody className="flex flex-col gap-3">
        {access.isError ? (
          <ErrorNote error={access.error} />
        ) : (
          <p className="text-[13px] text-ink-3">
            {enabled
              ? `已開啟${access.data?.updatedAt ? ` · ${formatWhen(access.data.updatedAt)}` : ''}`
              : `已關閉${access.data?.updatedAt ? ` · ${formatWhen(access.data.updatedAt)}` : '（預設）'}：agent 只能查詢版本資訊，無法操作任何專案。`}
          </p>
        )}
        {setAccess.isError && <ErrorNote error={setAccess.error} />}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="開啟 agent 存取？"
        confirmLabel="開啟 agent 存取"
        busy={setAccess.isPending}
        onConfirm={() => {
          setAccess.mutate(true, { onSettled: () => setConfirming(false) });
        }}
      >
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>外部 agent 可以透過 CLI 與 MCP 操作所有已連接的專案，不會每次詢問你。</li>
          <li>這包含保存版本、回復到舊版與取得更新。被誤導的 agent 可能在你不知情時回復版本。</li>
          <li>回復前一定會先把目前內容保存成保護版本，內容不會遺失；agent 做的回復會通知你。</li>
          <li>連接新資料夾、登入 GitHub、連接遠端與第一次推送，仍然只能由你在這裡完成。</li>
        </ul>
      </ConfirmDialog>
    </Card>
  );
}

// A POSIX shell word: as the user would type it in a terminal.
function shellWord(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={label}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? 'copied' : 'failed');
          setTimeout(() => setState('idle'), 1500);
        });
      }}
    >
      {state === 'copied' ? '已複製' : state === 'failed' ? '無法複製' : '複製'}
    </Button>
  );
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start gap-3">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-5 text-ink whitespace-pre">
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

// Where this installation's CLI, MCP server and Skill are, ready to paste
// into an agent host (M1 plan §4.1). It tells where things are; agent access
// stays the only thing that lets an agent in.
function AgentSetupCard() {
  const setup = useQuery({ queryKey: ['agentSetup'], queryFn: agentSetup, staleTime: Infinity });
  const s = setup.data;
  if (!s) return null;
  const cliLine = [s.command, ...s.args].map(shellWord).join(' ');
  const mcpConfig = JSON.stringify(
    { mcpServers: { 'draft-tide': { command: s.command, args: [...s.args, 'mcp', 'serve'] } } },
    null,
    2,
  );
  return (
    <Card aria-label="CLI / MCP / Skill 設定">
      <CardHeader
        title="CLI / MCP / Skill 設定"
        description="給 agent 宿主（例如 Claude Code）的設定。它們都連到這個 Draft Tide 引擎，只有在上面開啟 agent 存取後才能操作專案。"
      />
      <CardBody className="flex flex-col gap-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">命令列工具</p>
          <p className="mb-2 text-[12px] text-ink-3">
            在後面接上子命令，例如 <span className="font-mono">--json project list</span>。
          </p>
          <Snippet text={cliLine} label="複製 CLI 指令" />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">MCP server</p>
          <p className="mb-2 text-[12px] text-ink-3">
            貼到宿主的 MCP 設定（Claude Code、Claude Desktop、Cursor 等都用這個格式）。只在 Claude Code 實測過。
          </p>
          <Snippet text={mcpConfig} label="複製 MCP 設定" />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">Skill</p>
          {s.skillDir ? (
            <>
              <p className="mb-2 text-[12px] text-ink-3">
                把這個資料夾複製（或連結）到宿主的 skills 資料夾，例如{' '}
                <span className="font-mono">~/.claude/skills/draft-tide</span>。
              </p>
              <Snippet text={s.skillDir} label="複製 Skill 路徑" />
            </>
          ) : (
            <p className="text-[12px] text-ink-3">這個版本沒有附 Skill。</p>
          )}
        </div>
        {s.dataDir && (
          <p className="text-[12px] text-ink-3">
            這個視窗使用的資料目錄不是預設位置（{s.dataDir}），所以指令帶著 --data-dir。
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 py-1.5">
      <dt className="w-32 shrink-0 text-[13px] text-ink-3">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

function EngineCard({ connection }: { connection: ConnectionState }) {
  const info = useEngineInfo();
  const status =
    connection.status === 'connected' ? (
      <Badge tone="ok">已連線</Badge>
    ) : connection.status === 'connecting' ? (
      <Badge tone="warn">連線中</Badge>
    ) : (
      <Badge tone="danger">未連線</Badge>
    );
  return (
    <Card>
      <CardHeader
        title="引擎狀態"
        description="保存、歷史與回復都由這台電腦上的 Draft Tide 引擎處理。"
        action={status}
      />
      <CardBody>
        {info.isError ? (
          <ErrorNote error={info.error} />
        ) : info.data ? (
          <dl className="divide-y divide-line">
            <Row label="版本">{info.data.appVersion}</Row>
            <Row label="桌面身分驗證">
              {info.data.desktopIdentity === 'code-signature' ? (
                <Badge tone="ok">程式簽章驗證</Badge>
              ) : (
                <Badge tone="warn">開發版本：未驗證簽章</Badge>
              )}
            </Row>
            <Row label="啟動時間">{formatWhen(info.data.startedAt)}</Row>
            <Row label="執行環境">
              <span className="font-mono text-[12px]">
                Node {info.data.runtime.node} · SQLite {info.data.runtime.sqlite} · {info.data.runtime.platform}/
                {info.data.runtime.arch}
              </span>
            </Row>
            <Row label="診斷資訊">
              <span className="font-mono text-[12px] text-ink-2">
                instance {shortId(info.data.instanceId)} · protocol {info.data.protocolVersion} · storage{' '}
                {info.data.storageSchemaVersion}
              </span>
            </Row>
          </dl>
        ) : (
          <p className="text-[13px] text-ink-3">讀取中…</p>
        )}
      </CardBody>
    </Card>
  );
}

// Previews (M1 plan §8): whether this Draft Tide can render them, how, and
// the rebuildable cache, which can be cleared at any time.
function PreviewCard() {
  const status = usePreviewStatus();
  const client = useQueryClient();
  const clear = useMutation({
    mutationFn: () => engineCall('preview.clearCache', {}),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: previewStatusKey });
      void client.invalidateQueries({ queryKey: ['snapshot.preview'] });
      void client.invalidateQueries({ queryKey: usageKey });
    },
  });
  const s = status.data;
  return (
    <Card>
      <CardHeader
        title="畫面預覽"
        description="版本的畫面由獨立、離線的預覽程式產生，只存在這台電腦的快取中，不會放進設計資料夾或歷史。"
        action={s ? s.available ? <Badge tone="ok">可以使用</Badge> : <Badge tone="warn">無法使用</Badge> : undefined}
      />
      <CardBody>
        {status.isError ? (
          <ErrorNote error={status.error} />
        ) : s ? (
          <dl className="divide-y divide-line">
            {!s.available && (
              <Row label="原因">這個 Draft Tide 引擎沒有預覽程式（開發版本由 Draft Tide 視窗啟動引擎時才有）。</Row>
            )}
            {s.renderer && (
              <Row label="瀏覽器核心">
                <span className="font-mono text-[12px]">{s.renderer}</span>
              </Row>
            )}
            <Row label="固定設定">
              {s.settings.viewport.width}×{s.settings.viewport.height} · {s.settings.locale} · {s.settings.timezone} ·
              網路關閉
            </Row>
            <Row label="快取">
              <span className="flex flex-wrap items-center gap-3">
                {s.cache.entries} 個預覽 · {formatBytes(s.cache.bytes)}（上限 {formatBytes(s.cache.budgetBytes)}
                ，超過時移除最久沒用的）
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clear.mutate()}
                  disabled={clear.isPending || s.cache.entries === 0}
                >
                  {clear.isPending ? '清除中…' : '清除預覽快取'}
                </Button>
              </span>
            </Row>
          </dl>
        ) : (
          <p className="text-[13px] text-ink-3">讀取中…</p>
        )}
        {clear.data && (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-[13px] text-ok" role="status">
            <Check className="size-4" />
            已清除 {clear.data.entries} 個預覽（{formatBytes(clear.data.bytes)}）。需要時會重新產生。
          </p>
        )}
        {clear.isError && <ErrorNote className="mt-3" error={clear.error} />}
      </CardBody>
    </Card>
  );
}

// Agent requests waiting for the user (M1 plan §4.1, §9.1). Answering one is
// connecting a folder (picked in the native dialog, then reviewed), signing
// in to GitHub, or connecting a project to a repository.
function RequestsCard({ navigate }: { navigate: Navigate }) {
  const list = useOperationList();
  const requests = list.data?.requests.filter(isConnectRequest) ?? [];
  const github = list.data?.requests.filter(isGitHubRequest) ?? [];
  return (
    <Card>
      <CardHeader
        title="agent 請求的待處理操作"
        description="agent 只能請求連接新的資料夾、登入 GitHub 或連接 GitHub repo；由你在這裡完成，或拒絕。"
        action={
          requests.length + github.length > 0 ? (
            <Badge tone="agent">{requests.length + github.length} 個</Badge>
          ) : undefined
        }
      />
      <CardBody>
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isPending ? (
          <p className="text-[13px] text-ink-3">讀取中…</p>
        ) : requests.length + github.length === 0 ? (
          <p className="text-[13px] text-ink-3">目前沒有等待中的請求。</p>
        ) : (
          <div className="flex flex-col divide-y divide-line overflow-hidden rounded-md border border-line">
            {requests.map((r) => (
              <RequestRow key={r.operationId} request={r} navigate={navigate} />
            ))}
            {github.map((r) => (
              <GitHubRequestBanner key={r.operationId} request={r} navigate={navigate} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RequestRow({ request, navigate }: { request: ConnectRequest; navigate: Navigate }) {
  const { answer, picking } = useAnswerRequest(navigate);
  const decline = useDeclineRequest();
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <Agent className="mt-0.5 size-4 shrink-0 text-agent" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">連接資料夾</p>
          <p className="truncate font-mono text-[12px] text-ink-2" title={request.request.root}>
            {request.request.root}
          </p>
          <p className="text-[12px] text-ink-3">
            經 {ORIGIN_LABEL[request.origin]} · {formatWhen(request.createdAt)}
            {request.request.name ? ` · 建議名稱「${request.request.name}」` : ''}
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
      {decline.isError && <ErrorNote error={decline.error} />}
    </div>
  );
}

const ATTENTION_KIND: Record<OperationStatus['kind'], string> = {
  save: '保存版本',
  restore: '回復版本',
  pull: '取得 GitHub 的更新',
  open: '從 GitHub 開啟專案',
  'connect-request': '連接資料夾的請求',
  'login-request': '登入 GitHub 的請求',
  'remote-connect-request': '連接 GitHub repo 的請求',
};

// Operations that stopped part-way, in every project. Each project's page
// says what is left and offers to finish or roll back.
function AttentionCard({ navigate }: { navigate: Navigate }) {
  const list = useOperationList();
  const projects = useProjects();
  const attention = list.data?.attention ?? [];
  return (
    <Card>
      <CardHeader
        title="需要恢復的操作"
        description="操作在途中停止時會列在這裡。內容沒有遺失：開啟專案就能完成它，或還原成操作之前的內容。"
        action={attention.length > 0 ? <Badge tone="warn">{attention.length} 個</Badge> : undefined}
      />
      <CardBody>
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isPending ? (
          <p className="text-[13px] text-ink-3">讀取中…</p>
        ) : attention.length === 0 ? (
          <p className="text-[13px] text-ink-3">沒有需要恢復的操作。</p>
        ) : (
          <div className="flex flex-col divide-y divide-line rounded-md border border-line">
            {attention.map((op) => {
              const projectId = op.projectId;
              const project = projects.data?.find((p) => p.projectId === projectId);
              return (
                <div key={op.operationId} className="flex items-center gap-3 px-4 py-3">
                  <Alert className="size-4 shrink-0 text-warn" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">
                      {project?.name || '專案'} · {ATTENTION_KIND[op.kind]}
                    </p>
                    <p className="text-[12px] text-ink-3">
                      經 {ORIGIN_LABEL[op.origin]} · {formatWhen(op.createdAt)}
                    </p>
                  </div>
                  {projectId && (
                    <Button size="sm" variant="secondary" onClick={() => navigate({ name: 'project', projectId })}>
                      開啟專案
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---- 容量 (M1 plan §4.1, §6.3): what Draft Tide takes on this computer and
// the room left, with the steps that free some. Nothing here is a quota.

const usageKey = ['diagnostics.usage'] as const;
// Below this, saving and restoring may run short (they check exactly what
// they need first; this only warns early).
const LOW_SPACE_BYTES = 1024 * 1024 * 1024;

const PART_LABEL: Record<keyof StorageUsage['dataStore']['parts'], { label: string; note?: string }> = {
  database: { label: '本機狀態', note: '連接的專案、回復計畫、操作紀錄與同步佇列' },
  staging: { label: '進行中操作的暫存', note: '操作結束後自動清除' },
  previews: { label: '畫面預覽快取', note: '可在下方「畫面預覽」清除，需要時會重新產生' },
  logs: { label: '記錄檔' },
  desktop: { label: 'App 的瀏覽器資料' },
  other: { label: '其他' },
};

function StorageCard() {
  const usage = useQuery({
    queryKey: usageKey,
    queryFn: () => engineCall('diagnostics.usage', {}),
    staleTime: 30_000,
  });
  const u = usage.data;
  const low = (n: number | null) => n !== null && n < LOW_SPACE_BYTES;
  const lowSpace = u ? low(u.dataStore.availableBytes) || u.projects.some((p) => low(p.availableBytes)) : false;
  return (
    <Card aria-label="容量">
      <CardHeader
        title="容量"
        description="Draft Tide 在這台電腦上用了多少空間、還有多少可用空間。每個專案的歷史就在它資料夾的 .git 裡。"
        action={
          <Button size="sm" variant="ghost" onClick={() => void usage.refetch()} disabled={usage.isFetching}>
            {usage.isFetching ? '計算中…' : '重新計算'}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {usage.isError ? (
          <ErrorNote error={usage.error} />
        ) : !u ? (
          <p className="text-[13px] text-ink-3">計算中…</p>
        ) : (
          <>
            {lowSpace && (
              <div
                className="flex gap-3 rounded-lg border border-warn-line bg-warn-soft px-4 py-3 text-[13px] text-warn"
                role="status"
              >
                <Alert className="mt-0.5 size-4 shrink-0" />
                <p>
                  可用空間不到 {formatBytes(LOW_SPACE_BYTES)}
                  。保存與回復都需要空間：可以清除畫面預覽快取、完成需要恢復的操作（它們的暫存會一起清除），或移走其他不需要的檔案。
                </p>
              </div>
            )}
            <div>
              <p className="mb-1 text-[13px] font-medium text-ink">Draft Tide 的資料</p>
              <dl className="divide-y divide-line">
                {(Object.keys(PART_LABEL) as (keyof typeof PART_LABEL)[]).map((part) => (
                  <Row key={part} label={PART_LABEL[part].label}>
                    {formatBytes(u.dataStore.parts[part])}
                    {PART_LABEL[part].note && (
                      <span className="text-[12px] text-ink-3"> · {PART_LABEL[part].note}</span>
                    )}
                  </Row>
                ))}
                <Row label="合計">
                  <span className="font-medium">{formatBytes(u.dataStore.total)}</span>
                  {!u.dataStore.complete && <span className="text-[12px] text-ink-3"> · 項目太多，只計算了一部分</span>}
                </Row>
                <Row label="可用空間">
                  {u.dataStore.availableBytes === null ? '無法讀取' : formatBytes(u.dataStore.availableBytes)}
                </Row>
              </dl>
            </div>
            <div>
              <p className="mb-1 text-[13px] font-medium text-ink">各專案的歷史</p>
              {u.projects.length === 0 ? (
                <p className="text-[13px] text-ink-3">還沒有連接任何專案。</p>
              ) : (
                <dl className="divide-y divide-line">
                  {u.projects.map((p) => (
                    <Row key={p.projectId} label={p.name || '專案'}>
                      {p.historyBytes === null ? (
                        <span className="text-ink-3">無法讀取（資料夾或它的 .git 不在原處）</span>
                      ) : (
                        <>
                          歷史 {formatBytes(p.historyBytes)}
                          {p.availableBytes !== null && (
                            <span className="text-[12px] text-ink-3">
                              {' '}
                              · {p.sameVolumeAsDataStore ? '同一個磁碟' : '所在磁碟'}可用{' '}
                              {formatBytes(p.availableBytes)}
                            </span>
                          )}
                        </>
                      )}
                    </Row>
                  ))}
                </dl>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ---- 診斷資訊 (M1 plan §4.1): a de-identified report the user saves and
// sends with a problem report. Draft Tide sends nothing itself. Main writes
// the file; the app shows what was saved.
function DiagnosticsCard() {
  const [saved, setSaved] = useState<Extract<DiagnosticsExport, { status: 'saved' }> | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      const result = await exportDiagnostics();
      if (result?.status === 'failed') throw new EngineCallError(result.error);
      return result;
    },
    onSuccess: (result) => {
      if (result?.status === 'saved') setSaved(result);
    },
  });
  return (
    <Card aria-label="診斷資訊">
      <CardHeader
        title="診斷資訊"
        description="遇到問題時，可以把一份去識別化的診斷資訊存成檔案，附在問題回報裡。Draft Tide 不會自行傳送任何資料。"
      />
      <CardBody className="flex flex-col gap-3">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-ink-2">
          <li>
            包含：版本與執行環境、容量、每個專案與操作的狀態和錯誤代碼（以 project-1
            這類代號表示），以及引擎記錄檔的最後一段。
          </li>
          <li>
            不包含：設計檔案的內容、檔名與資料夾路徑、專案名稱、GitHub 帳號與 repo
            名稱、登入資訊。記錄檔裡的路徑、名稱與識別碼都換成了代號。
          </li>
        </ul>
        <div>
          <Button size="sm" variant="secondary" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? '匯出中…' : '匯出診斷資訊…'}
          </Button>
        </div>
        {run.isError && <ErrorNote error={run.error} />}
        {saved && (
          <div className="flex flex-col gap-2">
            <p
              className="flex flex-wrap items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-[13px] text-ok"
              role="status"
            >
              <Check className="size-4" />
              已儲存「{saved.fileName}」。傳送前可以先打開看看內容。
              <Button size="sm" variant="ghost" onClick={() => void revealDiagnostics()}>
                顯示檔案位置
              </Button>
            </p>
            <Details summary="檢視內容">
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre text-ink">
                {JSON.stringify(saved.report, null, 2)}
              </pre>
            </Details>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function SettingsScreen({ connection, navigate }: { connection: ConnectionState; navigate: Navigate }) {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-page pt-10 pb-24">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">設定與診斷</h1>
        <p className="mt-1 text-ink-2">agent 存取、待處理的請求、中斷的操作、引擎、畫面預覽、容量與診斷資訊。</p>
      </div>
      <AgentAccessCard />
      <AgentSetupCard />
      <RequestsCard navigate={navigate} />
      <AttentionCard navigate={navigate} />
      <EngineCard connection={connection} />
      <PreviewCard />
      <StorageCard />
      <DiagnosticsCard />
    </div>
  );
}
