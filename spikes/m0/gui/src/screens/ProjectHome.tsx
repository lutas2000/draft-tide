import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { DesignFrame } from '../components/DesignFrame';
import { FileChangeList, summarizeChanges } from '../components/FileChangeList';
import { Alert, Bot, Check, Columns, Dot, Expand, Pencil, Restore, Save, Spinner } from '../components/Icons';
import { SourceBadge } from '../components/SourceBadge';
import { VersionCard, versionTitle } from '../components/VersionCard';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { Details, MetaList } from '../components/ui/Details';
import { Dialog } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import { formatBytes, formatFull, formatWhen } from '../lib/format';
import { shortHash } from '../lib/hash';
import { diffFiles, findVersion, latestVersion, totalSize, unsavedChanges, versionMatchingWorking, type CaptureStage } from '../mock/engine';
import type { Project, ProjectId, SnapshotId, Version } from '../mock/types';
import { useProjectActions } from '../state/actions';
import { useStore, useProject } from '../state/store';
import { RelinkDialog } from './RelinkDialog';

const ORIGIN_LABEL = { gui: 'Draft Tide 視窗', cli: 'CLI', mcp: 'MCP' } as const;

export function ProjectHome({ projectId, focus }: { projectId: ProjectId; focus?: SnapshotId }) {
  const project = useProject(projectId);
  const { state, navigate } = useStore();
  const [selectedId, setSelectedId] = useState<SnapshotId | null>(focus ?? null);
  const [relink, setRelink] = useState(false);

  useEffect(() => {
    if (focus) setSelectedId(focus);
  }, [focus]);

  if (!project) return null;
  const versionsNewestFirst = [...project.versions].reverse();
  const selected = (selectedId && findVersion(project, selectedId)) || latestVersion(project);
  const current = versionMatchingWorking(project);
  const unsaved = unsavedChanges(project);
  const pending = state.pending.filter((p) => p.projectId === project.id);

  return (
    <div className="flex h-full min-h-0">
      <div className="dt-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-page pt-6 pb-24">
          {!project.sourceAvailable && (
            <div className="flex items-start gap-3 rounded-lg border border-warn-line bg-warn-soft px-4 py-3" role="status">
              <Alert className="mt-0.5 size-4 text-warn" />
              <div className="flex-1 text-[13px]">
                <p className="font-semibold text-warn">找不到來源資料夾</p>
                <p className="mt-0.5 text-ink-2">
                  {project.displayPath} 可能被移動、重新命名，或在未連接的磁碟上。歷史仍可查看與比較；要保存或回復，請先重新指定位置。Draft Tide 不會自動搜尋你的磁碟。
                </p>
              </div>
              <Button size="sm" onClick={() => setRelink(true)}>
                重新指定位置…
              </Button>
            </div>
          )}

          {pending.map((req) => {
            const target = findVersion(project, req.targetId);
            return (
              <div key={req.id} className="flex items-center gap-3 rounded-lg border border-agent/25 bg-agent-soft px-4 py-3">
                <Bot className="size-4 text-agent" />
                <p className="flex-1 text-[13px] text-ink">
                  <strong className="font-semibold">外部 Agent 請求回復到 {target?.label}</strong>
                  <span className="text-ink-2">
                    （經 {ORIGIN_LABEL[req.origin]}，{formatWhen(req.requestedAt)}）。在你確認之前不會變更任何檔案。
                  </span>
                </p>
                <Button
                  size="sm"
                  onClick={() => navigate({ name: 'restore', projectId: project.id, targetId: req.targetId, requestId: req.id })}
                >
                  檢視請求
                </Button>
              </div>
            );
          })}

          <StatusBar project={project} onRelink={() => setRelink(true)} />

          <section aria-labelledby="history-title" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <div className="flex items-baseline gap-3">
                <h1 id="history-title" className="text-[18px] font-semibold tracking-tight">
                  版本歷史
                </h1>
                <span className="text-[13px] text-ink-3">{project.versions.length} 個版本 · 新的在前</span>
              </div>
              <Button
                size="sm"
                disabled={project.versions.length < 2}
                onClick={() => {
                  const last = latestVersion(project);
                  const prev = project.versions[project.versions.length - 2];
                  if (last && prev)
                    navigate({ name: 'compare', projectId: project.id, leftId: prev.meta.snapshotId, rightId: last.meta.snapshotId });
                }}
              >
                <Columns />
                比較版本
              </Button>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {versionsNewestFirst.map((v) => (
                <VersionCard
                  key={v.meta.snapshotId}
                  version={v}
                  entry={project.entry}
                  selected={selected?.meta.snapshotId === v.meta.snapshotId}
                  isCurrent={unsaved.length === 0 && current?.meta.snapshotId === v.meta.snapshotId}
                  highlight={focus === v.meta.snapshotId}
                  onSelect={() => setSelectedId(v.meta.snapshotId)}
                />
              ))}
            </div>
            <p className="text-[12px] text-ink-3">回復舊版會新增版本，不會刪除任何歷史。</p>
          </section>
        </div>
      </div>

      {selected && <VersionPanel project={project} version={selected} isCurrent={unsaved.length === 0 && current?.meta.snapshotId === selected.meta.snapshotId} />}
      {relink && <RelinkDialog project={project} onClose={() => setRelink(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusBar({ project, onRelink }: { project: Project; onRelink: () => void }) {
  const { toast } = useStore();
  const { simulateEdit, saveVersion } = useProjectActions();
  const [saveOpen, setSaveOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const unsaved = unsavedChanges(project);
  const last = latestVersion(project);

  const quickCheck = async () => {
    setChecking(true);
    const result = await saveVersion(project.id, '');
    setChecking(false);
    if (!result.ok && result.code === 'NO_CHANGES') {
      toast({ tone: 'info', title: '沒有新的變更，不會建立重複版本', body: `資料夾內容與 ${result.same.label} 相同。` });
    } else if (result.ok) {
      toast({ tone: 'ok', title: `已保存 ${result.version.label}` });
    }
  };

  if (!project.sourceAvailable) {
    return (
      <Card className="flex items-center gap-4 px-5 py-4">
        <span className="grid size-9 place-items-center rounded-full bg-sunken text-ink-3">
          <Alert />
        </span>
        <div className="flex-1">
          <p className="font-semibold">目前無法保存</p>
          <p className="text-[13px] text-ink-2">需要先重新指定來源資料夾，才能讀取檔案。</p>
        </div>
        <Button onClick={onRelink}>重新指定位置…</Button>
      </Card>
    );
  }

  return (
    <Card className={cn('px-5 py-4', unsaved.length > 0 && 'border-warn-line')}>
      <div className="flex items-center gap-4">
        {unsaved.length > 0 ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
            <Dot />
          </span>
        ) : (
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ok-soft text-ok">
            <Check />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {unsaved.length > 0 ? (
            <>
              <p className="text-[15px] font-semibold">有 {unsaved.length} 個檔案尚未保存</p>
              <p className="line-clamp-2 text-[13px] text-ink-2">
                與 {last?.label} 相比：{summarizeChanges(unsaved)}（{unsaved.map((c) => c.path).slice(0, 3).join('、')}
                {unsaved.length > 3 ? '…' : ''}）
              </p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-semibold">沒有新的變更</p>
              <p className="text-[13px] text-ink-2">
                資料夾內容與 {last?.label}「{last ? versionTitle(last) : ''}」相同，不會建立重複版本。
              </p>
            </>
          )}
        </div>
        {unsaved.length > 0 ? (
          <Button variant="primary" onClick={() => setSaveOpen(true)}>
            <Save />
            保存版本
          </Button>
        ) : (
          <Button onClick={quickCheck} disabled={checking}>
            {checking ? <Spinner /> : <Save />}
            {checking ? '檢查中…' : '保存版本'}
          </Button>
        )}
      </div>
      <div className="mt-3 flex items-start gap-3 border-t border-line pt-3">
        {unsaved.length > 0 ? (
          <Details summary="查看尚未保存的變更" className="min-w-0 flex-1">
            <FileChangeList changes={unsaved} />
          </Details>
        ) : (
          <p className="min-w-0 flex-1 text-[12px] text-ink-3">在你的編輯器修改並存檔後，回到這裡保存版本。</p>
        )}
        <Button variant="demo" size="sm" className="-my-1" onClick={() => simulateEdit(project.id)}>
          <Pencil className="size-3.5" />
          （原型）模擬在編輯器修改
        </Button>
      </div>
      <SaveVersionDialog open={saveOpen} project={project} onClose={() => setSaveOpen(false)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------

const STAGE_TEXT: Record<CaptureStage, string> = {
  reading: '讀取檔案…',
  verifying: '確認檔案在讀取期間沒有變動…',
  writing: '寫入版本歷史…',
};

function SaveVersionDialog({ open, project, onClose }: { open: boolean; project: Project; onClose: () => void }) {
  const { toast } = useStore();
  const { saveVersion } = useProjectActions();
  const [name, setName] = useState('');
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const unsaved = unsavedChanges(project);
  const reused = project.working.length - unsaved.filter((c) => c.status !== 'deleted').length;

  useEffect(() => {
    if (open) {
      setName('');
      setStage(null);
      setNotice(null);
    }
  }, [open]);

  const submit = async () => {
    const result = await saveVersion(project.id, name, setStage);
    setStage(null);
    if (result.ok) {
      onClose();
      toast({
        tone: 'ok',
        title: `已保存 ${result.version.label}${result.version.meta.name ? `「${result.version.meta.name}」` : ''}`,
        body: '預覽會在背景產生，不影響已保存的版本。',
      });
    } else if (result.code === 'NO_CHANGES') {
      setNotice(`沒有新的變更，不會建立重複版本。資料夾內容與 ${result.same.label} 相同。`);
    } else {
      setNotice('找不到來源資料夾，這次沒有保存。請先重新指定位置。');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={stage === null}
      title="保存版本"
      description="保存資料夾目前的內容。之後可以隨時比較或回復到這個版本。"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button onClick={onClose} disabled={stage !== null}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={stage !== null}>
            {stage ? <Spinner /> : <Save />}
            {stage ? '保存中…' : '保存版本'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (stage === null) void submit();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[13px] font-medium">
            版本名稱 <span className="font-normal text-ink-3">（可選）</span>
          </label>
          <input
            id={nameId}
            aria-describedby={`${nameId}-hint`}
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：加入年繳切換"
            maxLength={80}
            disabled={stage !== null}
            className="h-10 rounded-md border border-line-strong bg-surface px-3 text-sm focus:border-tide-500 focus:outline-none focus-visible:outline-2"
          />
          <span id={`${nameId}-hint`} className="text-[12px] text-ink-3">
            沒填也沒關係，版本會以時間辨識。
          </span>
        </div>
        <div className="rounded-lg bg-raised px-4 py-3 text-[13px] text-ink-2">
          <p>
            <strong className="text-ink">{unsaved.length} 個檔案有變更</strong>（{summarizeChanges(unsaved)}）。其餘 {Math.max(0, reused)}{' '}
            個檔案沿用上一版，不會重複佔用空間。
          </p>
        </div>
        {stage && (
          <p className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
            <Spinner />
            {STAGE_TEXT[stage]}
          </p>
        )}
        {notice && (
          <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2" role="status">
            {notice}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function VersionPanel({ project, version, isCurrent }: { project: Project; version: Version; isCurrent: boolean }) {
  const { navigate } = useStore();
  const [zoom, setZoom] = useState(false);
  const idx = project.versions.findIndex((v) => v.meta.snapshotId === version.meta.snapshotId);
  const prev = idx > 0 ? project.versions[idx - 1] : undefined;
  const last = latestVersion(project);
  const vsPrev = useMemo(() => (prev ? diffFiles(prev.files, version.files) : []), [prev, version]);
  const restoreOf = version.meta.restoreOf ? findVersion(project, version.meta.restoreOf) : undefined;
  const isLatest = last?.meta.snapshotId === version.meta.snapshotId;

  const compareTarget = isLatest ? prev : last;
  const title = versionTitle(version);

  return (
    <aside
      aria-label={`${version.label} 詳細內容`}
      className="dt-scroll flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface px-5 pt-6 pb-10"
    >
      <div className="relative">
        <DesignFrame files={version.files} entry={project.entry} title={`${version.label} 預覽`} status={version.previewStatus} />
        <button
          type="button"
          onClick={() => setZoom(true)}
          className="absolute right-2 bottom-2 flex items-center gap-1 rounded-sm bg-surface/95 px-2 py-1 text-[12px] font-medium text-ink-2 shadow-card hover:text-ink"
        >
          <Expand className="size-3.5" />
          放大預覽
        </button>
      </div>

      <div>
        <p className="text-[12px] font-semibold tracking-wide text-ink-3">{version.label}</p>
        <h2 className={cn('text-[18px] leading-snug font-semibold', !version.meta.name && 'text-ink-3')}>{title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SourceBadge kind={version.meta.kind} />
          <time className="text-[12px] text-ink-3" dateTime={version.meta.createdAt}>
            {formatFull(version.meta.createdAt)}
          </time>
        </div>
      </div>

      {version.meta.kind === 'agent-requested' && (
        <p className="rounded-md bg-agent-soft px-3 py-2 text-[12px] text-ink-2">
          外部 Agent 經 {ORIGIN_LABEL[version.meta.origin ?? 'mcp']} 請求保存了這個版本。這只表示「有人請求保存」，不代表 Agent 的任務已完成或設計已確認。
        </p>
      )}
      {version.meta.kind === 'pre-restore' && (
        <p className="rounded-md bg-protect-soft px-3 py-2 text-[12px] text-ink-2">回復前自動保存的內容。想回到回復前的樣子，可以回復到這個版本。</p>
      )}
      {version.meta.kind === 'restore' && restoreOf && (
        <p className="rounded-md bg-restore-soft px-3 py-2 text-[12px] text-ink-2">
          內容與 {restoreOf.label}「{versionTitle(restoreOf)}」相同。之前的版本都還在歷史中。
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          disabled={!project.sourceAvailable || isCurrent}
          onClick={() => navigate({ name: 'restore', projectId: project.id, targetId: version.meta.snapshotId })}
        >
          <Restore />
          回復到此版
        </Button>
        {isCurrent && <p className="text-center text-[12px] text-ink-3">資料夾目前就是這個版本的內容</p>}
        {!project.sourceAvailable && <p className="text-center text-[12px] text-ink-3">重新指定來源資料夾後才能回復</p>}
        {compareTarget ? (
          <Button
            onClick={() => {
              const [l, r] = isLatest ? [compareTarget, version] : [version, compareTarget];
              navigate({ name: 'compare', projectId: project.id, leftId: l.meta.snapshotId, rightId: r.meta.snapshotId });
            }}
          >
            <Columns />
            {isLatest ? `與上一版（${compareTarget.label}）比較` : `與最新版（${compareTarget.label}）比較`}
          </Button>
        ) : (
          <p className="text-center text-[12px] text-ink-3">保存第二個版本後，就可以比較兩版的差異。</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <SectionTitle>檔案</SectionTitle>
        <p className="text-[13px] text-ink-2">
          {version.files.length} 個檔案 · {formatBytes(totalSize(version.files))}
        </p>
        {prev && (
          <p className="text-[13px] text-ink-2">
            與 {prev.label} 相比：{vsPrev.length ? summarizeChanges(vsPrev) : '沒有差異'}
          </p>
        )}
      </div>

      <Details summary="詳細資訊" className="border-t border-line pt-4">
        <MetaList
          rows={[
            ['版本 ID', version.meta.snapshotId],
            ['Git commit', version.commitOid],
            ['類型', version.meta.kind],
            ['入口來源', version.meta.origin ? `${version.meta.origin}（${ORIGIN_LABEL[version.meta.origin]}）` : '—'],
            ['建立時間 (UTC)', version.meta.createdAt],
            ['保存範圍', shortHash(version.meta.scopeHash)],
            ['預覽入口', version.meta.entryFiles.join(', ')],
            ...(version.meta.restoreOf ? ([['回復自', version.meta.restoreOf]] as Array<[string, string]>) : []),
            ...(version.meta.operationId ? ([['操作 ID', version.meta.operationId]] as Array<[string, string]>) : []),
          ]}
        />
        <p className="mt-2 text-[11px] text-ink-3">V 編號只是顯示用；永久引用使用版本 ID。原型中的 ID 與雜湊為示意資料。</p>
      </Details>

      <Dialog open={zoom} onClose={() => setZoom(false)} size="xl" title={`${version.label}「${title}」`} description={`預覽入口 ${project.entry} · 1280 × 800 · 不執行腳本、不連網`}>
        <DesignFrame files={version.files} entry={project.entry} title={`${version.label} 放大預覽`} status={version.previewStatus} />
      </Dialog>
    </aside>
  );
}
