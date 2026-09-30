import { useEffect, useMemo, useState } from 'react';
import { DesignFrame } from '../components/DesignFrame';
import { Alert, Check, ChevronLeft, File, Folder, ImageIcon, Info, Link, Shield, Spinner } from '../components/Icons';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { Details } from '../components/ui/Details';
import { cn } from '../lib/cn';
import { formatBytes } from '../lib/format';
import { bindProject } from '../mock/data';
import { totalSize } from '../mock/engine';
import { useProjectActions } from '../state/actions';
import { useStore } from '../state/store';

export function ScopeReview() {
  const { state, dispatch, navigate, markStep, toast } = useStore();
  const { markPreviewReady } = useProjectActions();
  const draft = state.scopeDraft;
  const [name, setName] = useState(draft?.suggestedName ?? '');
  const [entry, setEntry] = useState(draft?.entryCandidates[0] ?? 'index.html');
  const [excludedUnsupported, setExcludedUnsupported] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<null | 'reading' | 'writing'>(null);

  useEffect(() => {
    markStep(2);
  }, [markStep]);

  const largest = useMemo(
    () => (draft ? [...draft.files].sort((a, b) => b.size - a.size).slice(0, 3) : []),
    [draft],
  );

  if (!draft) {
    return (
      <div className="grid h-full place-items-center">
        <Button onClick={() => navigate({ name: 'start' })}>回到專案列表</Button>
      </div>
    );
  }

  const unresolved = draft.unsupported.filter((u) => !excludedUnsupported.has(u.path));
  const size = totalSize(draft.files);

  const confirm = () => {
    setSaving('reading');
    window.setTimeout(() => setSaving('writing'), 700);
    window.setTimeout(() => {
      const project = bindProject(draft, name, entry);
      dispatch({ type: 'addProject', project });
      dispatch({ type: 'setScopeDraft', draft: null });
      markPreviewReady(project.id, project.versions.map((v) => v.meta.snapshotId));
      markStep(3);
      navigate({ name: 'project', projectId: project.id });
      toast({ tone: 'ok', title: '已保存第一版', body: '之後在編輯器修改檔案，回到這裡按「保存版本」即可。' });
    }, 1500);
  };

  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-6 px-page pt-6 pb-24">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'start' })} disabled={saving !== null}>
            <ChevronLeft />
            返回
          </Button>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">確認保存範圍</h1>
            <p className="text-[13px] text-ink-2">保存第一版之前，先確認哪些檔案會被保存。確認後才會開始建立歷史。</p>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-6">
          <div className="flex flex-col gap-5">
            {/* Project */}
            <Card className="p-5">
              <SectionTitle className="mb-4">專案</SectionTitle>
              <div className="grid grid-cols-[120px_1fr] items-center gap-x-4 gap-y-4">
                <label htmlFor="project-name" className="text-[13px] text-ink-2">
                  專案名稱
                </label>
                <input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm focus:border-tide-500 focus:outline-none focus-visible:outline-2"
                />
                <span className="text-[13px] text-ink-2">資料夾</span>
                <span className="flex min-w-0 items-center gap-2">
                  <Folder className="size-4 text-tide-600" />
                  <span className="shrink-0 font-medium whitespace-nowrap">{draft.folderName}</span>
                  <span className="min-w-0 truncate text-[13px] text-ink-3" title={draft.displayPath}>
                    {draft.displayPath}
                  </span>
                  {draft.source === 'example' && <Badge tone="tide">範例複本</Badge>}
                </span>
                <label htmlFor="entry" className="text-[13px] text-ink-2">
                  預覽入口
                </label>
                <span className="flex items-center gap-3">
                  <select
                    id="entry"
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                    className="h-9 rounded-md border border-line-strong bg-surface px-2.5 font-mono text-[13px] focus:border-tide-500"
                  >
                    {draft.entryCandidates.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <span className="text-[12px] text-ink-3">縮圖與比較畫面會從這個檔案產生</span>
                </span>
              </div>
            </Card>

            {/* Included */}
            <Card className="p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <SectionTitle>會保存的內容</SectionTitle>
                <span className="text-[13px] text-ink-2">
                  <strong className="text-ink">{draft.files.length} 個檔案</strong> · {formatBytes(size)}
                </span>
              </div>
              <p className="mb-3 text-[13px] text-ink-2">每個版本都保存這些檔案的原始內容。沒有變動的檔案不會重複佔用空間。</p>
              <p className="mb-2 text-[12px] text-ink-3">較大的檔案</p>
              <ul className="mb-3 flex flex-col gap-1.5">
                {largest.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-[13px]">
                    {f.kind === 'binary' ? <ImageIcon className="size-4 text-ink-3" /> : <File className="size-4 text-ink-3" />}
                    <span className="flex-1 truncate font-mono">{f.path}</span>
                    <span className="text-ink-2">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
              <Details summary={`查看全部 ${draft.files.length} 個檔案`}>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-raised p-3">
                  {draft.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 text-[12px]">
                      <span className="flex-1 truncate font-mono text-ink-2">{f.path}</span>
                      <span className="text-ink-3">{formatBytes(f.size)}</span>
                    </li>
                  ))}
                </ul>
              </Details>
            </Card>

            {/* Unsupported — blocking */}
            {draft.unsupported.length > 0 && (
              <Card
                className={cn('p-5', unresolved.length > 0 ? 'border-warn-line bg-warn-soft/40' : '')}
                aria-labelledby="unsupported-title"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Alert className={cn('size-4', unresolved.length > 0 ? 'text-warn' : 'text-ok')} />
                  <SectionTitle id="unsupported-title">不支援的項目</SectionTitle>
                  {unresolved.length > 0 ? (
                    <Badge tone="warn">需要你處理</Badge>
                  ) : (
                    <Badge tone="ok" icon={<Check className="size-3" />}>
                      已處理
                    </Badge>
                  )}
                </div>
                {draft.unsupported.map((u) => {
                  const excluded = excludedUnsupported.has(u.path);
                  return (
                    <div key={u.path} className="rounded-lg border border-line bg-surface p-4">
                      <div className="flex items-center gap-2">
                        <Link className="size-4 text-ink-3" />
                        <code className="font-mono text-[13px] font-medium">
                          {u.path} → {u.target}
                        </code>
                        <Badge tone="outline">捷徑（symbolic link）</Badge>
                      </div>
                      <p className="mt-2 text-[13px] text-ink-2">{u.detail}</p>
                      <div className="mt-3 flex items-center gap-2">
                        {excluded ? (
                          <>
                            <span className="flex items-center gap-1.5 text-[13px] font-medium text-ok">
                              <Check />
                              已排除，不會保存
                            </span>
                            <Button
                              variant="quiet"
                              size="sm"
                              onClick={() =>
                                setExcludedUnsupported((s) => {
                                  const n = new Set(s);
                                  n.delete(u.path);
                                  return n;
                                })
                              }
                            >
                              復原
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" onClick={() => setExcludedUnsupported((s) => new Set(s).add(u.path))}>
                              排除此項目
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'start' })}>
                              改選其他資料夾
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Card>
            )}

            {/* Excluded */}
            <Card className="p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <SectionTitle>不會保存的項目</SectionTitle>
                <span className="text-[12px] text-ink-3">預設排除</span>
              </div>
              <ul className="flex flex-col divide-y divide-line">
                {draft.excluded.map((e) => (
                  <li key={e.path} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    {e.kind === 'dir' ? <Folder className="mt-0.5 size-4 text-ink-3" /> : <File className="mt-0.5 size-4 text-ink-3" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-[13px] font-medium">{e.path}</code>
                        <span className="text-[13px] text-ink-2">{e.reason}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-ink-3">{e.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            {/* History location */}
            <Card className="p-5">
              <SectionTitle className="mb-3">歷史儲存位置</SectionTitle>
              <div className="flex items-start gap-3">
                <Shield className="mt-0.5 size-4 text-tide-600" />
                <div className="text-[13px] text-ink-2">
                  <p>
                    版本歷史保存在這台電腦的 Draft Tide 資料中（
                    <code className="font-mono text-[12px]">{draft.historyLocation}</code>
                    ），不會放進你的設計資料夾，也不會改動資料夾裡原有的 <code className="font-mono">.git</code>。
                  </p>
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-tide-50 px-3 py-2 text-tide-900">
                    <Info className="mt-0.5 size-3.5 text-tide-600" />
                    只複製設計資料夾不會帶走歷史；要帶走或換電腦時，請用「備份」。
                  </p>
                </div>
              </div>
            </Card>
          </div>

          {/* Right rail */}
          <div className="sticky top-6 flex flex-col gap-4">
            <Card className="p-3">
              <DesignFrame files={draft.files} entry={entry} title="預覽入口畫面" />
              <p className="mt-2 px-1 text-[12px] text-ink-3">
                預覽入口：<code className="font-mono">{entry}</code> · 1280 × 800
              </p>
            </Card>
            <Card className="flex flex-col gap-3 p-5">
              <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
                <dt className="text-ink-2">會保存</dt>
                <dd className="font-medium">
                  {draft.files.length} 個檔案 · {formatBytes(size)}
                </dd>
                <dt className="text-ink-2">預估使用空間</dt>
                <dd className="font-medium">約 {formatBytes(Math.round(size * 1.05))}</dd>
                <dt className="text-ink-2">目前可用空間</dt>
                <dd className="font-medium">{formatBytes(draft.freeSpace)}</dd>
              </dl>
              {unresolved.length > 0 && (
                <p className="flex items-start gap-1.5 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
                  <Alert className="mt-0.5 size-3.5" />
                  還有 {unresolved.length} 個不支援的項目需要處理，才能繼續。
                </p>
              )}
              <Button
                variant="primary"
                size="lg"
                disabled={unresolved.length > 0 || saving !== null || name.trim() === ''}
                onClick={confirm}
              >
                {saving ? (
                  <>
                    <Spinner />
                    {saving === 'reading' ? '讀取檔案並確認內容…' : '建立第一版…'}
                  </>
                ) : (
                  '確認並保存第一版'
                )}
              </Button>
              <p className="text-[12px] text-ink-3">保存範圍在建立後固定；之後若要調整，會另外請你確認。</p>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
