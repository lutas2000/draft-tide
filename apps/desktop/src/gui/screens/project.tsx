import { useEffect, useId, useState } from 'react';
import {
  DtError,
  type HistoryEntry,
  type ProjectId,
  type ProjectStatus,
  type SavedSnapshot,
  type StatusChange,
} from '@draft-tide/contracts';
import { Agent, Alert, Branch, Check, ChevronLeft, Columns, Dot, Folder, Person, Save } from '../components/icons.tsx';
import { SaveProgressLine } from '../components/progress.tsx';
import { Badge, type BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Details } from '../components/ui/details.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { cn } from '../lib/cn.ts';
import { ENTRY_KIND_COPY, FOLDER_STATE_COPY, KIND_LABEL, ORIGIN_LABEL, blockerCopy } from '../lib/copy.ts';
import { useHistory, useOperationProgress, useProjectStatus, useSave } from '../lib/engine-state.ts';
import { entryTime, entryTitle, formatFull, formatWhen, versionLabel } from '../lib/format.ts';
import type { Navigate, Route } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// A connected project (M1 plan §4.1 版本歷史): what changed since the newest
// version, saving, and the branch's history, including other tools' commits
// shown as external changes.

const KIND_TONE: Record<string, BadgeTone> = {
  baseline: 'tide',
  manual: 'neutral',
  'agent-requested': 'agent',
  'pre-restore': 'warn',
  restore: 'ok',
};

// The permanent reference to an entry: its snapshot id, or its commit.
export function refOf(e: HistoryEntry): string {
  return e.source === 'draft-tide' && e.snapshot ? e.snapshot.snapshotId : e.commit;
}

export function SourceBadge({ entry }: { entry: HistoryEntry }) {
  if (entry.source === 'draft-tide' && entry.snapshot) {
    return <Badge tone={KIND_TONE[entry.snapshot.kind] ?? 'neutral'}>{KIND_LABEL[entry.snapshot.kind]}</Badge>;
  }
  if (entry.source === 'unreadable') return <Badge tone="warn">無法讀取的版本</Badge>;
  return <Badge tone="outline">外部變更</Badge>;
}

const CHANGE_LABEL: Record<StatusChange['change'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '刪除',
  renamed: '改名',
};

export function summarize(c: { added: number; modified: number; deleted: number; renamed: number }): string {
  const parts: string[] = [];
  if (c.modified) parts.push(`修改 ${c.modified}`);
  if (c.added) parts.push(`新增 ${c.added}`);
  if (c.deleted) parts.push(`刪除 ${c.deleted}`);
  if (c.renamed) parts.push(`改名 ${c.renamed}`);
  return parts.join(' · ');
}

export function ProjectScreen({
  projectId,
  navigate,
  notice,
}: {
  projectId: ProjectId;
  navigate: Navigate;
  notice?: Extract<Route, { name: 'project' }>['notice'];
}) {
  const status = useProjectStatus(projectId);
  const history = useHistory(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(notice ?? null);

  const entries = history.data?.pages.flatMap((p) => p.entries) ?? [];
  const current = entries.find((e) => e.commit === selected) ?? entries[0] ?? null;

  // Another tool may have committed (an engineer, an agent's own git): when
  // the branch's tip moves, the history is read again.
  const statusTip = status.data?.tip?.commit ?? null;
  const historyTip = history.data?.pages[0]?.tip ?? null;
  const refetchHistory = history.refetch;
  useEffect(() => {
    if (status.data && history.data && statusTip !== historyTip) void refetchHistory();
  }, [statusTip, historyTip, status.data, history.data, refetchHistory]);

  return (
    <div className="flex h-full min-h-0">
      <div className="dt-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-page pt-6 pb-24">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'home' })}>
              <ChevronLeft />
              專案
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-[20px] font-semibold tracking-tight">
                {status.data?.name || status.data?.project.name || '專案'}
              </h1>
              {status.data && (
                <p className="flex items-center gap-3 text-[12px] text-ink-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Folder className="size-3.5 shrink-0" />
                    <span className="truncate" title={status.data.project.root}>
                      {status.data.project.root}
                    </span>
                  </span>
                  {status.data.branch && (
                    <span className="flex shrink-0 items-center gap-1">
                      <Branch className="size-3.5" />
                      {status.data.branch}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>

          {pending && (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-ink-2">資料夾已經連接，但第一版沒有保存成功：</p>
              <ErrorNote error={DtError.fromInfo(pending)} />
            </div>
          )}

          {status.isError ? (
            <ErrorNote error={status.error} />
          ) : status.isPending ? (
            <Card className="px-5 py-6 text-[13px] text-ink-3" role="status">
              檢查資料夾…
            </Card>
          ) : (
            <StatusCard
              status={status.data}
              onSaved={() => setPending(null)}
              onRecheck={() => {
                void status.refetch();
                void history.refetch();
              }}
              rechecking={status.isFetching}
            />
          )}

          <section aria-labelledby="history-title" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <div className="flex items-baseline gap-3">
                <h2 id="history-title" className="text-[18px] font-semibold tracking-tight">
                  版本歷史
                </h2>
                {history.data && (
                  <span className="text-[13px] text-ink-3">
                    {history.data.pages[0]?.versions ?? 0} 個版本 · 新的在前
                  </span>
                )}
              </div>
              <Button
                size="sm"
                disabled={entries.length < 2}
                onClick={() => {
                  const [newest, older] = entries;
                  if (newest && older) navigate({ name: 'compare', projectId, from: refOf(older), to: refOf(newest) });
                }}
              >
                <Columns />
                比較版本
              </Button>
            </div>
            {history.isError ? (
              <ErrorNote error={history.error} />
            ) : history.isPending ? (
              <Card className="px-5 py-6 text-[13px] text-ink-3">讀取歷史…</Card>
            ) : entries.length === 0 ? (
              <Card className="px-5 py-8 text-center">
                <p className="font-medium text-ink">還沒有版本</p>
                <p className="mt-1 text-[13px] text-ink-3">按「保存版本」建立第一版。</p>
              </Card>
            ) : (
              <Card>
                <ul className="divide-y divide-line" aria-label="版本歷史">
                  {entries.map((e) => (
                    <HistoryRow
                      key={e.commit}
                      entry={e}
                      selected={current?.commit === e.commit}
                      onSelect={() => setSelected(e.commit)}
                    />
                  ))}
                </ul>
              </Card>
            )}
            {history.hasNextPage && (
              <Button
                variant="ghost"
                onClick={() => void history.fetchNextPage()}
                disabled={history.isFetchingNextPage}
              >
                {history.isFetchingNextPage ? '讀取中…' : '顯示更早的版本'}
              </Button>
            )}
            <p className="text-[12px] text-ink-3">
              「外部變更」是其他工具（例如工程師的 git commit）加入的內容，也是歷史的一部分。Draft Tide
              不會改寫或刪除任何歷史。
            </p>
          </section>
        </div>
      </div>
      {current && (
        <VersionPanel
          key={current.commit}
          entry={current}
          entries={entries}
          onCompare={(from, to) => navigate({ name: 'compare', projectId, from: refOf(from), to: refOf(to) })}
        />
      )}
    </div>
  );
}

function HistoryRow({ entry, selected, onSelect }: { entry: HistoryEntry; selected: boolean; onSelect: () => void }) {
  const label = versionLabel(entry);
  const when = entryTime(entry);
  return (
    <li className="first:rounded-t-lg last:rounded-b-lg">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-raised',
          selected && 'bg-tide-50 hover:bg-tide-50',
        )}
      >
        <span
          className={cn(
            'flex h-7 w-11 shrink-0 items-center justify-center rounded-sm text-[12px] font-semibold',
            label ? 'bg-ink/80 text-white' : 'bg-sunken text-ink-3',
          )}
        >
          {label ?? <Person className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-[14px] font-medium text-ink',
              entry.source === 'draft-tide' && !entry.snapshot?.name && 'text-ink-2',
            )}
          >
            {entryTitle(entry)}
          </span>
          <span className="block truncate text-[12px] text-ink-3">
            {entry.source === 'draft-tide' && entry.snapshot
              ? `經 ${ORIGIN_LABEL[entry.snapshot.origin]}`
              : `由 ${entry.authorName || '不明的作者'}`}
            {when && ` · ${formatWhen(when)}`}
          </span>
        </span>
        <SourceBadge entry={entry} />
      </button>
    </li>
  );
}

function StatusCard({
  status,
  onSaved,
  onRecheck,
  rechecking,
}: {
  status: ProjectStatus;
  onSaved: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ saved: SavedSnapshot } | { error: unknown } | null>(null);
  const progress = useOperationProgress(status.project.projectId);
  const saving = status.saving || progress !== null;

  if (status.folder !== 'available') {
    const copy = FOLDER_STATE_COPY[status.folder];
    return (
      <Card className="flex items-start gap-4 border-warn-line px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
          <Alert />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">{copy.title}</p>
          <p className="text-[13px] text-ink-2">{copy.next}</p>
          {status.folder === 'missing' && (
            <p className="mt-1 font-mono text-[12px] text-ink-3">{status.project.root}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRecheck} disabled={rechecking}>
          {rechecking ? '檢查中…' : '重新檢查'}
        </Button>
      </Card>
    );
  }

  const changes = status.changes;
  const blocked = status.blockers.length > 0 || status.unsupported.count > 0 || status.recoveryRequired;
  const noVersions = status.tip === null;
  const dirty = changes !== null && changes.total > 0;
  return (
    <Card className={cn('px-5 py-4', dirty && 'border-warn-line')}>
      <div className="flex items-center gap-4">
        {dirty || noVersions ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
            <Dot />
          </span>
        ) : (
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ok-soft text-ok">
            <Check />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {noVersions ? (
            <>
              <p className="text-[15px] font-semibold">還沒有保存任何版本</p>
              <p className="text-[13px] text-ink-2">保存第一版之後，就能隨時比較與找回。</p>
            </>
          ) : dirty ? (
            <>
              <p className="text-[15px] font-semibold">有 {changes.total} 個檔案尚未保存</p>
              <p className="truncate text-[13px] text-ink-2">
                與最新版本相比：{summarize(changes)}（
                {changes.entries
                  .slice(0, 3)
                  .map((c) => c.path)
                  .join('、')}
                {changes.total > 3 ? '…' : ''}）
              </p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-semibold">沒有新的變更</p>
              <p className="text-[13px] text-ink-2">資料夾內容與最新版本相同。</p>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRecheck} disabled={rechecking || saving}>
          {rechecking ? '檢查中…' : '重新檢查'}
        </Button>
        <Button
          variant={dirty || noVersions ? 'primary' : 'secondary'}
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
          disabled={saving || blocked}
        >
          <Save />
          保存版本
        </Button>
      </div>

      {saving && (
        <div className="mt-3 border-t border-line pt-3">
          <SaveProgressLine
            event={progress}
            fallback={
              progress?.origin && progress.origin !== 'gui' ? `${ORIGIN_LABEL[progress.origin]} 正在保存…` : '保存中…'
            }
          />
        </div>
      )}
      {status.recoveryRequired && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <Alert className="mt-0.5 size-4 shrink-0" />
          上一次的保存沒有完成最後一步，版本已在歷史中。請勿手動刪除 .git/index.lock；完成恢復的功能會在後續版本提供。
        </p>
      )}
      {status.blockers.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {status.blockers.map((b) => {
            const copy = blockerCopy(b);
            return (
              <li key={`${b.code}:${b.reason}`} className="rounded-md bg-danger-soft px-3 py-2 text-[13px]">
                <p className="font-medium text-danger">{copy.title}</p>
                <p className="text-ink-2">{copy.next}</p>
              </li>
            );
          })}
        </ul>
      )}
      {status.unsupported.count > 0 && (
        <div className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-[13px]">
          <p className="font-medium text-warn">有 {status.unsupported.count} 個項目無法保存，處理之前無法保存版本：</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {status.unsupported.entries.slice(0, 10).map((u) => (
              <li key={`${u.kind}:${u.path}`} className="truncate font-mono text-[12px] text-ink-2">
                {u.path} · <span className="font-sans">{ENTRY_KIND_COPY[u.kind]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {dirty && (
        <div className="mt-3 border-t border-line pt-3">
          <Details summary="查看尚未保存的變更">
            <ul className="flex flex-col gap-1">
              {changes.entries.map((c) => (
                <li key={c.path} className="flex items-center gap-2 text-[13px]">
                  <Badge
                    tone={c.change === 'deleted' ? 'danger' : c.change === 'added' ? 'ok' : 'warn'}
                    className="w-11 justify-center"
                  >
                    {CHANGE_LABEL[c.change]}
                  </Badge>
                  <span className="truncate font-mono text-[12px]">
                    {c.previousPath ? `${c.previousPath} → ${c.path}` : c.path}
                  </span>
                </li>
              ))}
              {changes.entries.length < changes.total && (
                <li className="text-[12px] text-ink-3">另外 {changes.total - changes.entries.length} 個…</li>
              )}
            </ul>
          </Details>
        </div>
      )}
      {result && 'saved' in result && (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-[13px] text-ok" role="status">
          <Check className="size-4" />
          已保存{result.saved.name ? `「${result.saved.name}」` : '新版本'}。
        </p>
      )}
      {result && 'error' in result && <ErrorNote className="mt-3" error={result.error} />}
      <SaveDialog
        projectId={status.project.projectId}
        open={open}
        onOpenChange={setOpen}
        changed={changes?.total ?? null}
        onDone={(r) => {
          setResult(r);
          if ('saved' in r) onSaved();
        }}
      />
    </Card>
  );
}

function SaveDialog({
  projectId,
  open,
  onOpenChange,
  changed,
  onDone,
}: {
  projectId: ProjectId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changed: number | null;
  onDone: (result: { saved: SavedSnapshot } | { error: unknown }) => void;
}) {
  const save = useSave(projectId);
  const progress = useOperationProgress(projectId);
  const [name, setName] = useState('');
  const nameId = useId();

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = () => {
    save.mutate(name, {
      onSuccess: (saved) => {
        onOpenChange(false);
        onDone({ saved });
      },
      onError: (error) => {
        // Nothing to save, or a failure the dialog can't fix: say so on the page.
        onOpenChange(false);
        onDone({ error });
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={save.isPending}
      title="保存版本"
      description="保存資料夾目前的內容。之後可以隨時比較或找回這個版本。"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            <Save />
            {save.isPending ? '保存中…' : '保存版本'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[13px] font-medium">
            版本名稱 <span className="font-normal text-ink-3">（可選）</span>
          </label>
          <input
            id={nameId}
            autoFocus
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：加入年繳切換"
            disabled={save.isPending}
            className="h-10 rounded-md border border-line-strong bg-surface px-3 text-sm focus:border-tide-500 focus:outline-none focus-visible:outline-2"
          />
          <span className="text-[12px] text-ink-3">沒填也沒關係，版本會以時間辨識。</span>
        </div>
        {changed !== null && changed > 0 && (
          <p className="rounded-lg bg-raised px-4 py-3 text-[13px] text-ink-2">
            <strong className="text-ink">{changed} 個檔案有變更</strong>。沒有變動的檔案沿用上一版，不會重複佔用空間。
          </p>
        )}
        {save.isPending && <SaveProgressLine event={progress} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function VersionPanel({
  entry,
  entries,
  onCompare,
}: {
  entry: HistoryEntry;
  entries: HistoryEntry[];
  onCompare: (from: HistoryEntry, to: HistoryEntry) => void;
}) {
  const index = entries.findIndex((e) => e.commit === entry.commit);
  const older = index >= 0 ? entries[index + 1] : undefined;
  const newest = entries[0];
  const isNewest = newest?.commit === entry.commit;
  const label = versionLabel(entry);
  const when = entryTime(entry);
  const copyOf = entry.copyOf ? entries.find((e) => e.commit === entry.copyOf) : undefined;

  return (
    <aside
      aria-label="版本詳細內容"
      className="dt-scroll flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface px-5 pt-6 pb-10"
    >
      <div>
        <p className="text-[12px] font-semibold tracking-wide text-ink-3">{label ?? '外部變更'}</p>
        <h2 className="text-[18px] leading-snug font-semibold break-words">{entryTitle(entry)}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SourceBadge entry={entry} />
          {when && (
            <time className="text-[12px] text-ink-3" dateTime={when}>
              {formatFull(when)}
            </time>
          )}
        </div>
      </div>

      {entry.source === 'draft-tide' && entry.snapshot?.kind === 'agent-requested' && (
        <p className="flex items-start gap-2 rounded-md bg-agent-soft px-3 py-2 text-[12px] text-ink-2">
          <Agent className="mt-0.5 size-4 shrink-0 text-agent" />
          外部 agent 經 {ORIGIN_LABEL[entry.snapshot.origin]} 請求保存了這個版本。這只表示「有人請求保存」，不代表 agent
          的任務已完成或設計已確認。
        </p>
      )}
      {entry.source === 'external' && (
        <p className="rounded-md bg-raised px-3 py-2 text-[12px] text-ink-2">
          由其他工具加入（作者：{entry.authorName || '不明'}），例如工程師或 agent 自己執行的 git
          commit。它是歷史的一部分，Draft Tide 不會改動它。
        </p>
      )}
      {entry.source === 'copy' && (
        <p className="rounded-md bg-raised px-3 py-2 text-[12px] text-ink-2">
          其他工具把{copyOf ? `${versionLabel(copyOf) ?? ''}「${entryTitle(copyOf)}」` : '較早的一個版本'}
          複製到了這裡（例如 cherry-pick）。它沿用原本的版本 ID，所以顯示為外部變更。
        </p>
      )}
      {entry.source === 'unreadable' && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn">
          {entry.unreadable === 'newer-schema'
            ? '這個版本由較新版本的 Draft Tide 保存，部分資訊無法顯示。更新 Draft Tide 後即可讀取。'
            : '這個版本附帶的 Draft Tide 資訊無法讀取（可能被其他工具改過），所以當作外部變更顯示。'}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {older ? (
          <Button onClick={() => onCompare(older, entry)}>
            <Columns />
            與上一筆比較
          </Button>
        ) : (
          <p className="text-center text-[12px] text-ink-3">這是最早的一筆；保存更多版本後就能比較差異。</p>
        )}
        {!isNewest && newest && (
          <Button onClick={() => onCompare(entry, newest)}>
            <Columns />
            與最新的一筆比較
          </Button>
        )}
      </div>

      <Details summary="詳細資訊" className="border-t border-line pt-4">
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          {entry.snapshot && (
            <>
              <dt className="text-ink-3">版本 ID</dt>
              <dd className="font-mono break-all text-ink-2">{entry.snapshot.snapshotId}</dd>
              <dt className="text-ink-3">建立方式</dt>
              <dd className="text-ink-2">
                {KIND_LABEL[entry.snapshot.kind]}（{ORIGIN_LABEL[entry.snapshot.origin]}）
              </dd>
            </>
          )}
          <dt className="text-ink-3">Git commit</dt>
          <dd className="font-mono break-all text-ink-2">{entry.commit}</dd>
          <dt className="text-ink-3">作者</dt>
          <dd className="break-all text-ink-2">{entry.authorName}</dd>
          {entry.parents.length > 1 && (
            <>
              <dt className="text-ink-3">合併</dt>
              <dd className="text-ink-2">合併了 {entry.parents.length} 條歷史</dd>
            </>
          )}
        </dl>
        <p className="mt-2 text-[11px] text-ink-3">V 編號只是顯示用；永久引用使用版本 ID 或 Git commit。</p>
      </Details>
    </aside>
  );
}
