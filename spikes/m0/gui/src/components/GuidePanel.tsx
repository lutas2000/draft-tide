import { useState } from 'react';
import { cn } from '../lib/cn';
import { makeScopeDraft, DEMO_PROJECT_ID } from '../mock/data';
import { fingerprint, latestVersion, unsavedChanges } from '../mock/engine';
import type { Project } from '../mock/types';
import { useProjectActions } from '../state/actions';
import { useStore, type AppState } from '../state/store';
import { Check, ChevronDown, Compass, Pencil } from './Icons';
import { Button } from './ui/Button';

/** M1 §2.1 steps 1–8, phrased as tasks a facilitator can read aloud. */
export const GUIDE_STEPS = [
  { title: '開始使用', task: '選「試用範例」或「開啟設計資料夾」。' },
  { title: '檢視保存範圍', task: '找出專案名稱、位置、預覽入口、哪些檔案會保存或排除，以及歷史存放位置。' },
  { title: '保存第一版', task: '確認範圍，建立第一個版本。' },
  { title: '修改後保存新版本', task: '在原本的編輯器修改檔案，回來按「保存版本」並取個名字。' },
  { title: '找舊版並比較', task: '從版本卡片找到舊版，看縮圖、來源，以及兩版的畫面與檔案差異。' },
  { title: '回復到舊版', task: '選「回復到此版」，檢查會覆寫、新增、刪除哪些檔案，確認後執行。' },
  { title: '查看回復結果', task: '找到新的回復版本和回復前保護版本，再回到編輯器繼續工作。' },
  { title: '備份與匯入', task: '匯出歷史備份，並匯入到一個新的空白資料夾。' },
] as const;

/** The project a step should act on: the one on screen, else the most recent usable one. */
export function currentProject(state: AppState): Project | undefined {
  const id = 'projectId' in state.route ? state.route.projectId : undefined;
  return (id ? state.projects.find((p) => p.id === id) : undefined) ?? state.projects.find((p) => p.sourceAvailable);
}

function withHistory(state: AppState): Project | undefined {
  const p = currentProject(state);
  if (p && p.versions.length >= 2 && p.sourceAvailable) return p;
  return state.projects.find((x) => x.id === DEMO_PROJECT_ID);
}

export function GuidePanel() {
  const { state, dispatch, navigate } = useStore();
  const { simulateEdit } = useProjectActions();
  const done = new Set(state.guideDone);
  const project = currentProject(state);
  const onProjectScreen = state.route.name === 'project' && project?.sourceAvailable;
  const [confirmReset, setConfirmReset] = useState(false);

  const jump = (step: number) => {
    switch (step) {
      case 1:
        navigate({ name: 'start' });
        break;
      case 2:
      case 3:
        if (!state.scopeDraft) dispatch({ type: 'setScopeDraft', draft: makeScopeDraft('example') });
        navigate({ name: 'scope' });
        break;
      case 4:
        if (project) navigate({ name: 'project', projectId: project.id });
        break;
      case 5: {
        const p = withHistory(state);
        const first = p?.versions[0];
        const last = p && latestVersion(p);
        if (p && first && last) navigate({ name: 'compare', projectId: p.id, leftId: first.meta.snapshotId, rightId: last.meta.snapshotId });
        break;
      }
      case 6: {
        const p = withHistory(state);
        if (!p) break;
        // Prefer the oldest version whose content differs from the folder, so there is something to restore.
        const live = fingerprint(p.working);
        const target = p.versions.find((v) => fingerprint(v.files) !== live) ?? p.versions[0];
        if (target) navigate({ name: 'restore', projectId: p.id, targetId: target.meta.snapshotId });
        break;
      }
      case 7: {
        const p = withHistory(state);
        if (!p) break;
        const restore = [...p.versions].reverse().find((v) => v.meta.kind === 'restore');
        navigate(restore ? { name: 'project', projectId: p.id, focus: restore.meta.snapshotId } : { name: 'project', projectId: p.id });
        break;
      }
      case 8:
        if (project) {
          navigate({ name: 'project', projectId: project.id });
          dispatch({ type: 'backupOpen', open: true });
        }
        break;
    }
  };

  if (!state.guideOpen) {
    return (
      <button
        type="button"
        onClick={() => dispatch({ type: 'guideOpen', open: true })}
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 shadow-raised hover:text-ink"
      >
        <Compass />
        導覽 {done.size}/{GUIDE_STEPS.length}
      </button>
    );
  }

  return (
    <aside aria-label="導覽：手動流程測試" className="flex w-[272px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Compass className="size-4 text-tide-600" />
        <div className="flex-1">
          <p className="text-[13px] font-semibold">導覽 · 手動流程測試</p>
          <p className="text-[11px] text-ink-3">
            完成 {done.size} / {GUIDE_STEPS.length} · 點步驟可直接前往
          </p>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: 'guideOpen', open: false })}
          className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink"
          aria-label="收合導覽"
        >
          <ChevronDown />
        </button>
      </div>
      <ol className="dt-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {GUIDE_STEPS.map((s, i) => {
          const n = i + 1;
          const isDone = done.has(n);
          return (
            <li key={n}>
              <button
                type="button"
                onClick={() => jump(n)}
                className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-raised"
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                    isDone ? 'bg-tide-600 text-white' : 'border border-line-strong text-ink-3',
                  )}
                  aria-hidden="true"
                >
                  {isDone ? <Check className="size-3" /> : n}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[13px] font-medium', isDone ? 'text-ink-2' : 'text-ink')}>
                    {s.title}
                    {isDone && <span className="sr-only">（已完成）</span>}
                  </span>
                  <span className="block text-[12px] leading-snug text-ink-3">{s.task}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-col gap-2 border-t border-dashed border-line-strong bg-raised px-4 py-3">
        <p className="text-[11px] font-medium tracking-wide text-ink-3">主持人工具（原型）</p>
        <Button
          variant="demo"
          size="sm"
          disabled={!onProjectScreen || !project}
          onClick={() => project && simulateEdit(project.id)}
          title={onProjectScreen ? undefined : '先打開一個可用的專案'}
        >
          <Pencil className="size-3.5" />
          模擬在編輯器修改檔案
          {project && onProjectScreen && unsavedChanges(project).length > 0 && (
            <span className="text-ink-3">（再改一次）</span>
          )}
        </Button>
        {confirmReset ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[12px] text-ink-2">所有範例資料與進度都會回到初始狀態？</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmReset(false);
                dispatch({ type: 'reset' });
              }}
            >
              重設
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
            重設原型（給下一位受測者）
          </Button>
        )}
      </div>
    </aside>
  );
}
