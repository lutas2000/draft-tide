import { useEffect, useId, useMemo } from 'react';
import { DesignFrame } from '../components/DesignFrame';
import { FileChangeList, summarizeChanges } from '../components/FileChangeList';
import { ChevronLeft, Info, Restore, Swap } from '../components/Icons';
import { SourceBadge } from '../components/SourceBadge';
import { versionTitle } from '../components/VersionCard';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { formatWhen } from '../lib/format';
import { diffFiles, findVersion, versionMatchingWorking, unsavedChanges } from '../mock/engine';
import type { Project, ProjectId, SnapshotId, Version } from '../mock/types';
import { useProject, useStore } from '../state/store';

export function CompareScreen({ projectId, leftId, rightId }: { projectId: ProjectId; leftId: SnapshotId; rightId: SnapshotId }) {
  const project = useProject(projectId);
  const { navigate, markStep } = useStore();
  const left = project ? findVersion(project, leftId) : undefined;
  const right = project ? findVersion(project, rightId) : undefined;
  const changes = useMemo(() => (left && right ? diffFiles(left.files, right.files) : []), [left, right]);

  useEffect(() => {
    if (left && right && leftId !== rightId) markStep(5);
  }, [left, right, leftId, rightId, markStep]);

  if (!project || !left || !right) return null;
  const set = (l: SnapshotId, r: SnapshotId) => navigate({ name: 'compare', projectId, leftId: l, rightId: r });
  const same = leftId === rightId;
  const current = versionMatchingWorking(project);
  const firstText = changes.find((c) => (c.after ?? c.before)?.kind === 'text')?.path;

  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="flex flex-col gap-5 px-page pt-6 pb-24">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'project', projectId })}>
            <ChevronLeft />
            版本歷史
          </Button>
          <h1 className="text-[20px] font-semibold tracking-tight">比較版本</h1>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3">
          <ComparePane
            project={project}
            version={left}
            side="左"
            onPick={(id) => set(id, rightId)}
            isCurrent={unsavedChanges(project).length === 0 && current?.meta.snapshotId === left.meta.snapshotId}
            onRestore={() => navigate({ name: 'restore', projectId, targetId: leftId })}
          />
          <div className="flex h-full items-start pt-1">
            <Button variant="ghost" size="sm" aria-label="左右交換" title="左右交換" onClick={() => set(rightId, leftId)}>
              <Swap />
            </Button>
          </div>
          <ComparePane
            project={project}
            version={right}
            side="右"
            onPick={(id) => set(leftId, id)}
            isCurrent={unsavedChanges(project).length === 0 && current?.meta.snapshotId === right.meta.snapshotId}
            onRestore={() => navigate({ name: 'restore', projectId, targetId: rightId })}
          />
        </div>

        <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
          <Info className="size-3.5" />
          兩邊都以 1280 × 800 視窗、相同設定產生預覽；不執行腳本、不連網。畫面看起來不同，不一定都是設計修改（例如動態內容）。
        </p>

        <section aria-labelledby="changes-title" className="flex flex-col gap-3">
          <div className="flex items-baseline gap-3">
            <SectionTitle id="changes-title">檔案變更</SectionTitle>
            {!same && (
              <span className="text-[13px] text-ink-2">
                從 {left.label} 到 {right.label}：{changes.length ? summarizeChanges(changes) : '沒有差異'}
              </span>
            )}
          </div>
          {same ? (
            <Card className="px-4 py-6 text-center text-sm text-ink-3">請在左右選擇兩個不同的版本。</Card>
          ) : (
            <>
              <FileChangeList key={`${leftId}:${rightId}`} changes={changes} {...(firstText ? { defaultOpen: firstText } : {})} />
              <p className="text-[12px] text-ink-3">文字檔可展開查看逐行差異（唯讀）；圖片等二進位檔顯示大小與內容雜湊。</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ComparePane({
  project,
  version,
  side,
  onPick,
  onRestore,
  isCurrent,
}: {
  project: Project;
  version: Version;
  side: '左' | '右';
  onPick: (id: SnapshotId) => void;
  onRestore: () => void;
  isCurrent: boolean;
}) {
  const selectId = useId();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-2 px-1">
        <label htmlFor={selectId} className="sr-only">
          {side}側版本
        </label>
        <select
          id={selectId}
          value={version.meta.snapshotId}
          onChange={(e) => onPick(e.target.value as SnapshotId)}
          className="h-9 min-w-0 flex-1 truncate rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium focus:border-tide-500"
        >
          {[...project.versions].reverse().map((v) => (
            <option key={v.meta.snapshotId} value={v.meta.snapshotId}>
              {v.label} · {versionTitle(v)} · {formatWhen(v.meta.createdAt)}
            </option>
          ))}
        </select>
      </div>
      <DesignFrame files={version.files} entry={project.entry} title={`${version.label} 預覽`} status={version.previewStatus} />
      <div className="flex items-center gap-2 px-1 pb-1">
        <SourceBadge kind={version.meta.kind} />
        <span className="text-[12px] text-ink-3">{formatWhen(version.meta.createdAt)}</span>
        <span className="ml-auto" />
        {isCurrent ? (
          <span className="text-[12px] text-ink-3">資料夾目前是這版</span>
        ) : (
          <Button size="sm" onClick={onRestore} disabled={!project.sourceAvailable}>
            <Restore className="size-3.5" />
            回復到 {version.label}
          </Button>
        )}
      </div>
    </Card>
  );
}
