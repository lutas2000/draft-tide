import { useState, type ReactNode } from 'react';
import { DesignFrame } from '../components/DesignFrame';
import { Alert, ChevronRight, Folder, Sparkle, TideMark } from '../components/Icons';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, SectionTitle } from '../components/ui/Card';
import { Dialog } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import { formatWhen } from '../lib/format';
import { OPEN_FOLDER_CHOICES, makeScopeDraft } from '../mock/data';
import { latestVersion, unsavedChanges } from '../mock/engine';
import type { FolderChoice, Project } from '../mock/types';
import { useStore } from '../state/store';
import { FolderPicker } from './FolderPicker';
import { RelinkDialog } from './RelinkDialog';

export function StartScreen() {
  const { state, dispatch, navigate, markStep, toast } = useStore();
  const [picker, setPicker] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [exampleDest, setExampleDest] = useState('~/Documents/Draft Tide 範例');
  const [relink, setRelink] = useState<Project | null>(null);

  const openFolder = (choice: FolderChoice) => {
    setPicker(false);
    markStep(1);
    if (choice.boundProjectId) {
      navigate({ name: 'project', projectId: choice.boundProjectId });
      toast({ tone: 'info', title: '這個資料夾已經有版本歷史', body: '同一個資料夾只會對應一個專案，已為你開啟。' });
      return;
    }
    dispatch({ type: 'setScopeDraft', draft: makeScopeDraft('folder', choice) });
    navigate({ name: 'scope' });
  };

  const startExample = () => {
    setExampleOpen(false);
    markStep(1);
    const draft = makeScopeDraft('example');
    dispatch({
      type: 'setScopeDraft',
      draft: { ...draft, displayPath: `${exampleDest}/aurora-pricing` },
    });
    navigate({ name: 'scope' });
  };

  return (
    <div className="dt-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[920px] flex-col gap-10 px-page pt-14 pb-24">
        <div className="flex items-center gap-4">
          <TideMark className="size-12" />
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight">Draft Tide</h1>
            <p className="text-ink-2">
              Version history for your designs · <span className="text-ink-3">讓想法流動，讓每一稿留下。</span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <ActionCard
            icon={<Folder className="size-5" />}
            title="開啟設計資料夾"
            body="選一個放著設計稿的資料夾（例如含 index.html）。保存前會先讓你確認要保存哪些檔案。"
            onClick={() => setPicker(true)}
            primary
          />
          <ActionCard
            icon={<Sparkle className="size-5" />}
            title="試用範例"
            body="複製一份「Aurora 定價頁」範例到你選的位置，跟著兩個小修改練習保存、比較與回復。"
            onClick={() => setExampleOpen(true)}
          />
        </div>

        <section aria-labelledby="recent-title" className="flex flex-col gap-3">
          <SectionTitle id="recent-title">最近專案</SectionTitle>
          <Card className="divide-y divide-line overflow-hidden">
            {state.projects.map((p) => (
              <RecentRow
                key={p.id}
                project={p}
                onOpen={() => navigate({ name: 'project', projectId: p.id })}
                onRelink={() => setRelink(p)}
              />
            ))}
          </Card>
          <p className="text-[12px] text-ink-3">不需要帳號、網路或 Agent。版本歷史保存在這台電腦上。</p>
        </section>
      </div>

      <FolderPicker
        open={picker}
        title="選擇設計資料夾"
        choices={OPEN_FOLDER_CHOICES}
        confirmLabel="選擇"
        onCancel={() => setPicker(false)}
        onChoose={openFolder}
      />

      <Dialog
        open={exampleOpen}
        onClose={() => setExampleOpen(false)}
        title="要把範例放在哪裡？"
        description="Draft Tide 會複製一份範例專案到你選的位置，之後你可以用自己的編輯器修改它。"
        footer={
          <>
            <Button onClick={() => setExampleOpen(false)}>取消</Button>
            <Button variant="primary" onClick={startExample} data-autofocus>
              複製並繼續
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-3 rounded-lg border border-line bg-raised px-4 py-3">
          <Folder className="size-5 text-tide-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{exampleDest}/aurora-pricing</p>
            <p className="text-[12px] text-ink-3">會建立新的資料夾，不會覆寫既有檔案</p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setExampleDest((d) => (d === '~/Documents/Draft Tide 範例' ? '~/Desktop' : '~/Documents/Draft Tide 範例'))
            }
          >
            變更位置…
          </Button>
        </div>
        <p className="mt-3 text-[13px] text-ink-2">範例刻意包含幾個常見情況（例如捷徑與可能含密鑰的檔案），讓你看看 Draft Tide 會怎麼處理。</p>
      </Dialog>

      {relink && <RelinkDialog project={relink} onClose={() => setRelink(null)} />}
    </div>
  );
}

function ActionCard({
  icon,
  title,
  body,
  onClick,
  primary,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-start gap-4 rounded-xl border p-5 text-left shadow-card transition',
        primary ? 'border-tide-200 bg-tide-50 hover:border-tide-400' : 'border-line bg-surface hover:border-line-strong',
        'hover:shadow-raised',
      )}
    >
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-lg',
          primary ? 'bg-tide-600 text-white' : 'bg-sunken text-ink-2',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[16px] font-semibold text-ink">
          {title}
          <ChevronRight className="size-4 text-ink-3 transition group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-ink-2">{body}</span>
      </span>
    </button>
  );
}

function RecentRow({ project, onOpen, onRelink }: { project: Project; onOpen: () => void; onRelink: () => void }) {
  const last = latestVersion(project);
  const pending = unsavedChanges(project).length;
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="w-[112px] shrink-0">
        {last && <DesignFrame files={last.files} entry={project.entry} title={`${project.name} 縮圖`} status={last.previewStatus} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[15px] font-semibold">{project.name}</p>
          {project.importedFrom && <Badge tone="outline">由備份匯入</Badge>}
        </div>
        <p className="truncate text-[12px] text-ink-3">{project.displayPath}</p>
        {project.sourceAvailable ? (
          <p className="mt-1 text-[12px] text-ink-2">
            {project.versions.length} 個版本 · 最後保存 {last ? formatWhen(last.meta.createdAt) : '—'}
            {pending > 0 && <span className="text-warn"> · {pending} 個檔案尚未保存</span>}
          </p>
        ) : (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-warn">
            <Alert className="size-3.5" />
            <span>
              <strong className="font-semibold">找不到來源資料夾</strong>
              <span className="text-ink-2"> — 歷史仍可查看；可重新指定位置</span>
            </span>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!project.sourceAvailable && (
          <Button size="sm" onClick={onRelink}>
            重新指定位置…
          </Button>
        )}
        <Button size="sm" variant={project.sourceAvailable ? 'secondary' : 'ghost'} onClick={onOpen}>
          {project.sourceAvailable ? '開啟' : '查看歷史'}
        </Button>
      </div>
    </div>
  );
}
