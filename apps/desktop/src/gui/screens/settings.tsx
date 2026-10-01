import { useState, type ReactNode } from 'react';
import type { ConnectionState } from '../../shared/bridge.ts';
import { Agent } from '../components/icons.tsx';
import { ConfirmDialog } from '../components/ui/alert-dialog.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { useAgentAccess, useEngineInfo, useSetAgentAccess } from '../lib/engine-state.ts';
import { formatWhen, shortId } from '../lib/format.ts';
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

export function SettingsScreen({ connection }: { connection: ConnectionState }) {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-page pt-10 pb-24">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">設定與診斷</h1>
        <p className="mt-1 text-ink-2">agent 存取、引擎狀態與診斷資訊。</p>
      </div>
      <AgentAccessCard />
      <EngineCard connection={connection} />
      <Card>
        <CardHeader
          title="容量、診斷匯出與中斷恢復"
          description="查看歷史與暫存用量、匯出去識別化的診斷資訊，以及處理中斷的操作。"
          action={<Badge tone="outline">尚未提供</Badge>}
        />
      </Card>
    </div>
  );
}
