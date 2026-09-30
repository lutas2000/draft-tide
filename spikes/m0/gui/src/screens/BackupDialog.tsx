import { useEffect, useState } from 'react';
import { Alert, Archive, Check, Folder, Info, Save, Spinner } from '../components/Icons';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import { formatBytes, formatWhen } from '../lib/format';
import { IMPORT_DESTINATIONS } from '../mock/data';
import { exportBackup, historyBytes, importBackup, unsavedChanges, type BackupStage, type ImportStage } from '../mock/engine';
import type { FolderChoice, Project } from '../mock/types';
import { useProjectActions } from '../state/actions';
import { useStore } from '../state/store';
import { FolderPicker } from './FolderPicker';

const EXPORT_STAGES: Array<[BackupStage, string]> = [
  ['collect', '整理已保存的版本'],
  ['bundle', '打包成備份檔'],
  ['verify', '驗證備份可以完整還原'],
];

const IMPORT_STAGES: Array<[ImportStage, string]> = [
  ['check', '檢查備份內容與完整性'],
  ['history', '建立新的版本歷史'],
  ['files', '寫出最新版本的檔案'],
  ['verify', '驗證檔案與歷史'],
];

const DESTS = ['~/Documents/Draft Tide 備份', '/Volumes/外接硬碟/Draft Tide 備份'] as const;

export function BackupDialog({ project }: { project: Project }) {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [exported, setExported] = useState<{ fileName: string; size: number; versionCount: number; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) dispatch({ type: 'backupOpen', open: false });
  };

  useEffect(() => {
    if (state.backupOpen) setTab('export');
  }, [state.backupOpen]);

  return (
    <Dialog
      open={state.backupOpen}
      onClose={close}
      dismissible={!busy}
      size="lg"
      title="備份"
      description={`「${project.name}」的版本歷史。備份檔可以帶到其他電腦，或在需要時匯入。`}
    >
      <div role="tablist" aria-label="備份" className="mb-4 flex gap-1 rounded-lg bg-sunken p-1">
        {(
          [
            ['export', '匯出備份'],
            ['import', '匯入備份'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            disabled={busy}
            onClick={() => setTab(key)}
            className={cn(
              'flex-1 rounded-md py-1.5 text-[13px] font-medium',
              tab === key ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'export' ? (
        <ExportPanel project={project} busy={busy} setBusy={setBusy} exported={exported} onExported={setExported} />
      ) : (
        <ImportPanel project={project} busy={busy} setBusy={setBusy} exported={exported} />
      )}
    </Dialog>
  );
}

function Stages<T extends string>({ stages, current }: { stages: Array<[T, string]>; current: T | 'done' | null }) {
  const idx = current === 'done' ? stages.length : stages.findIndex(([k]) => k === current);
  return (
    <ol className="flex flex-col gap-1" aria-label="進度">
      {stages.map(([k, label], i) => (
        <li key={k} className="flex items-center gap-2.5 text-[13px]">
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full text-[10px]',
              i < idx && 'bg-tide-600 text-white',
              i === idx && 'bg-tide-100 text-tide-700',
              i > idx && 'border border-line-strong text-ink-3',
            )}
          >
            {i < idx ? <Check className="size-3" /> : i === idx ? <Spinner /> : i + 1}
          </span>
          <span className={i <= idx ? 'text-ink' : 'text-ink-3'}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function ExportPanel({
  project,
  busy,
  setBusy,
  exported,
  onExported,
}: {
  project: Project;
  busy: boolean;
  setBusy: (b: boolean) => void;
  exported: { fileName: string; size: number; versionCount: number } | null;
  onExported: (e: { fileName: string; size: number; versionCount: number; at: string }) => void;
}) {
  const { toast } = useStore();
  const { saveVersion } = useProjectActions();
  const [dest, setDest] = useState<(typeof DESTS)[number]>(DESTS[0]);
  const [stage, setStage] = useState<BackupStage | null>(null);
  const [savingFirst, setSavingFirst] = useState(false);
  const unsaved = unsavedChanges(project);
  const first = project.versions[0];
  const last = project.versions[project.versions.length - 1];
  const protections = project.versions.filter((v) => v.meta.kind === 'pre-restore').length;

  const run = async () => {
    setBusy(true);
    const r = await exportBackup(project, setStage);
    setBusy(false);
    onExported({ ...r, at: new Date().toISOString() });
  };

  if (exported && stage === 'done') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg bg-ok-soft px-4 py-3" role="status">
          <Check className="mt-0.5 size-4 text-ok" />
          <div className="text-[13px]">
            <p className="font-semibold text-ok">備份完成，已驗證</p>
            <p className="mt-0.5 text-ink-2">
              {exported.versionCount} 個版本 · {formatBytes(exported.size)}
            </p>
            <p className="mt-1 font-mono text-[12px] text-ink-2">
              {dest}/{exported.fileName}
            </p>
          </div>
        </div>
        <p className="text-[13px] text-ink-2">要確認備份可用，可以到「匯入備份」把它匯入到一個新的空白資料夾。</p>
        <div className="flex justify-end">
          <Button onClick={() => setStage(null)}>完成</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line px-4 py-3 text-[13px] text-ink-2">
        <p className="font-medium text-ink">備份只包含已保存的版本</p>
        <p className="mt-1">
          {first?.label}–{last?.label}，共 {project.versions.length} 個版本
          {protections > 0 ? `（含 ${protections} 個回復前保護版本）` : ''}，約 {formatBytes(historyBytes(project))} 的原始檔案。
        </p>
      </div>

      {unsaved.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-warn-soft px-4 py-3 text-[13px]">
          <Alert className="size-4 text-warn" />
          <p className="flex-1 text-ink-2">
            有 <strong className="text-ink">{unsaved.length} 個檔案尚未保存</strong>，不會包含在備份中。
          </p>
          <Button
            size="sm"
            disabled={savingFirst || busy}
            onClick={async () => {
              setSavingFirst(true);
              const r = await saveVersion(project.id, '備份前保存');
              setSavingFirst(false);
              if (r.ok) toast({ tone: 'ok', title: `已保存 ${r.version.label}`, body: '現在的內容會包含在備份中。' });
            }}
          >
            {savingFirst ? <Spinner /> : <Save />}
            先保存版本
          </Button>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-[13px] font-medium">儲存位置</p>
        <div className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5">
          <Folder className="size-4 text-tide-600" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
            {dest}/{project.folderName}-{new Date().toISOString().slice(0, 10)}.drafttide
          </span>
          <Button size="sm" disabled={busy} onClick={() => setDest((d) => (d === DESTS[0] ? DESTS[1] : DESTS[0]))}>
            變更位置…
          </Button>
        </div>
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-ink-3">
          <Info className="mt-0.5 size-3.5" />
          和歷史放在同一顆硬碟上，無法防止硬碟故障；建議存到外接硬碟或雲端硬碟資料夾。不會覆寫既有的檔案。
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-[12px] text-ink-2">
        <li>• 不包含：這台電腦上的資料夾路徑、Agent 設定與授權、預覽快取。</li>
        <li>• 設計檔案會原樣保存；若檔案本身含有敏感內容，備份也會包含。</li>
      </ul>

      {stage && <Stages stages={EXPORT_STAGES} current={stage} />}

      <div className="flex justify-end gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? <Spinner /> : <Archive />}
          {busy ? '匯出中…' : '匯出備份'}
        </Button>
      </div>
    </div>
  );
}

function ImportPanel({
  project,
  busy,
  setBusy,
  exported,
}: {
  project: Project;
  busy: boolean;
  setBusy: (b: boolean) => void;
  exported: { fileName: string; at: string; versionCount: number } | null;
}) {
  const { dispatch, navigate, markStep } = useStore();
  const [picked, setPicked] = useState(false);
  const [destPicker, setDestPicker] = useState(false);
  const [dest, setDest] = useState<FolderChoice | null>(null);
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [imported, setImported] = useState<Project | null>(null);

  const fileName = exported?.fileName ?? `${project.folderName}-${new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)}.drafttide`;
  const fileNote = exported ? `剛剛匯出 · ${formatWhen(exported.at)}` : '上次的備份';

  const run = async () => {
    if (!dest) return;
    setBusy(true);
    const p = await importBackup(project, dest, setStage);
    dispatch({ type: 'addProject', project: p });
    setBusy(false);
    setImported(p);
    markStep(8);
  };

  if (imported) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg bg-ok-soft px-4 py-3" role="status">
          <Check className="mt-0.5 size-4 text-ok" />
          <div className="text-[13px]">
            <p className="font-semibold text-ok">已匯入為新專案「{imported.name}」</p>
            <p className="mt-0.5 text-ink-2">
              {imported.versions.length} 個版本已還原到 {imported.displayPath}，版本 ID 與原本相同。原專案沒有被改動。
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={() => {
              dispatch({ type: 'backupOpen', open: false });
              navigate({ name: 'project', projectId: imported.id });
            }}
          >
            開啟匯入的專案
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-2">匯入只會建立新的專案，放到新的空白資料夾；不會合併或覆蓋既有專案。</p>

      <div>
        <p className="mb-1.5 text-[13px] font-medium">1. 備份檔</p>
        {picked ? (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5">
            <Archive className="size-4 text-tide-600" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[12px]">{fileName}</p>
              <p className="text-[12px] text-ink-3">
                {project.name} · {project.versions.length} 個版本 · 完整性檢查通過
              </p>
            </div>
            <Button size="sm" disabled={busy} onClick={() => setPicked(false)}>
              更換
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPicked(true)}
            className="flex w-full items-center gap-3 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left hover:border-tide-400 hover:bg-tide-50"
          >
            <Archive className="size-4 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px]">{fileName}</span>
              <span className="block text-[12px] text-ink-3">{fileNote} · 按一下選擇（原型：模擬選擇檔案）</span>
            </span>
          </button>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-medium">2. 匯入到</p>
        <div className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5">
          <Folder className="size-4 text-tide-600" />
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', !dest && 'text-ink-3')}>
            {dest ? `${dest.displayPath}（空白資料夾）` : '選擇一個新的空白資料夾'}
          </span>
          <Button size="sm" disabled={busy} onClick={() => setDestPicker(true)}>
            選擇資料夾…
          </Button>
        </div>
      </div>

      {stage && <Stages stages={IMPORT_STAGES} current={stage} />}

      <div className="flex justify-end">
        <Button variant="primary" disabled={!picked || !dest || busy} onClick={() => void run()}>
          {busy ? <Spinner /> : null}
          {busy ? '匯入中…' : '匯入'}
        </Button>
      </div>

      <FolderPicker
        open={destPicker}
        title="選擇匯入位置"
        hint="只能選擇空白資料夾。"
        choices={IMPORT_DESTINATIONS}
        confirmLabel="選擇"
        onCancel={() => setDestPicker(false)}
        validate={(c) => (c.empty ? null : '這個資料夾不是空的。匯入只能放到新的空白資料夾，不會合併或覆蓋既有檔案。')}
        onChoose={(c) => {
          setDest(c);
          setDestPicker(false);
        }}
      />
    </div>
  );
}
