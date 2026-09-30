import { useState } from 'react';
import { Check, Folder, Spinner } from '../components/Icons';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { RELINK_CHOICES } from '../mock/data';
import { latestVersion } from '../mock/engine';
import type { FolderChoice, Project } from '../mock/types';
import { useProjectActions } from '../state/actions';
import { useStore } from '../state/store';

/**
 * Re-point a project whose source folder went missing. Draft Tide never
 * searches the disk for a same-named folder; the designer points at it, the
 * Engine verifies the content, and only then is the binding updated.
 */
export function RelinkDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast } = useStore();
  const { update } = useProjectActions();
  const [choice, setChoice] = useState<FolderChoice | null>(null);
  const [phase, setPhase] = useState<'pick' | 'checking' | 'checked'>('pick');
  const last = latestVersion(project);

  const check = (c: FolderChoice) => {
    setChoice(c);
    setPhase('checking');
    window.setTimeout(() => setPhase('checked'), 900);
  };

  const confirm = () => {
    if (!choice || !last) return;
    update(project.id, (p) => ({
      ...p,
      sourceAvailable: true,
      displayPath: choice.displayPath,
      folderName: choice.folderName,
      working: last.files,
      workingDesign: last.design,
    }));
    toast({ tone: 'ok', title: '已重新連結來源資料夾', body: `${project.name} 現在指向 ${choice.displayPath}` });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="重新指定來源資料夾"
      description={`「${project.name}」原本在 ${project.displayPath}，現在找不到。請指出它的新位置。`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {phase === 'checked' && (
            <Button variant="primary" onClick={confirm} data-autofocus>
              使用這個資料夾
            </Button>
          )}
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">Draft Tide 不會自動搜尋你的磁碟或改用其他同名資料夾。在重新指定前，歷史仍可查看與比較。</p>
      {phase === 'pick' && (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-ink-3">原型：模擬系統的資料夾選擇視窗</p>
          {RELINK_CHOICES.map((c) => (
            <button
              key={c.displayPath}
              type="button"
              onClick={() => check(c)}
              data-autofocus
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left hover:border-tide-400 hover:bg-tide-50"
            >
              <Folder className="size-5 text-tide-600" />
              <span>
                <span className="block text-sm font-medium">{c.displayPath}</span>
                <span className="block text-[12px] text-ink-3">選擇此資料夾並核對內容</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {phase === 'checking' && (
        <p className="flex items-center gap-2 rounded-lg bg-raised px-4 py-3 text-sm text-ink-2" role="status">
          <Spinner />
          正在核對 {choice?.displayPath} 的內容…
        </p>
      )}
      {phase === 'checked' && last && (
        <div className="rounded-lg border border-ok/30 bg-ok-soft px-4 py-3 text-sm" role="status">
          <p className="flex items-center gap-2 font-medium text-ok">
            <Check />
            內容與最後保存的 {last.label} 相同
          </p>
          <p className="mt-1 text-[13px] text-ink-2">
            {last.files.length} 個檔案都相符。確認後，保存與回復會使用這個位置。
          </p>
        </div>
      )}
    </Dialog>
  );
}
