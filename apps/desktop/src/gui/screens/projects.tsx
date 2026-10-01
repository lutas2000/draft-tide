import { useState, type ReactNode } from 'react';
import { ChevronDown, Cloud, Folder, Sparkle, TideMark } from '../components/icons.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Card } from '../components/ui/card.tsx';
import { chooseFolder } from '../lib/bridge.ts';
import { useProjects } from '../lib/engine-state.ts';
import { formatWhen } from '../lib/format.ts';
import type { Navigate } from '../lib/route.ts';
import { ErrorNote } from './error-note.tsx';

// Entry points that later work packages enable. They are shown, but never as
// working: M1 must not present a capability it doesn't have (M1 plan §5.1).
function LaterAction({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div aria-disabled="true" className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-5 text-ink-3">
      <div className="flex items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-md bg-sunken text-ink-2">{icon}</span>
        <Badge tone="outline">尚未提供</Badge>
      </div>
      <div>
        <h3 className="text-[15px] font-semibold text-ink-2">{title}</h3>
        <p className="mt-1 text-[13px]">{body}</p>
      </div>
    </div>
  );
}

export function ProjectsScreen({ navigate }: { navigate: Navigate }) {
  const projects = useProjects();
  const [picking, setPicking] = useState(false);

  const open = async () => {
    setPicking(true);
    try {
      const root = await chooseFolder();
      if (root) navigate({ name: 'review', root });
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[920px] flex-col gap-10 px-page pt-12 pb-24">
      <div className="flex items-center gap-4">
        <TideMark className="size-12" />
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Draft Tide</h1>
          <p className="text-ink-2">
            Version history for your designs · <span className="text-ink-3">讓想法流動，讓每一稿留下。</span>
          </p>
        </div>
      </div>

      <section aria-labelledby="start-title" className="flex flex-col gap-3">
        <h2 id="start-title" className="text-[13px] font-medium text-ink-3">
          開始
        </h2>
        <div className="grid grid-cols-3 gap-4">
          <button
            type="button"
            onClick={() => void open()}
            disabled={picking}
            className="flex flex-col gap-3 rounded-lg border border-tide-200 bg-surface p-5 text-left shadow-card transition hover:border-tide-400 hover:shadow-raised disabled:opacity-60"
          >
            <span className="flex size-9 items-center justify-center rounded-md bg-tide-50 text-tide-600">
              <Folder className="size-5" />
            </span>
            <span>
              <span className="block text-[15px] font-semibold text-ink">開啟設計資料夾</span>
              <span className="mt-1 block text-[13px] text-ink-2">選擇資料夾、確認保存範圍，建立第一個版本。</span>
            </span>
          </button>
          <LaterAction
            icon={<Sparkle className="size-5" />}
            title="試用範例"
            body="複製一份範例設計到你選的位置，跟著兩個步驟試用。"
          />
          <LaterAction
            icon={<Cloud className="size-5" />}
            title="從 GitHub 開啟"
            body="把已同步的專案開到一個空白資料夾，歷史完整保留。"
          />
        </div>
      </section>

      <section aria-labelledby="recent-title" className="flex flex-col gap-3">
        <h2 id="recent-title" className="text-[13px] font-medium text-ink-3">
          專案
        </h2>
        {projects.isPending ? (
          <Card className="px-5 py-8 text-center text-ink-3">讀取中…</Card>
        ) : projects.isError ? (
          <ErrorNote error={projects.error} />
        ) : projects.data.length === 0 ? (
          <Card className="px-5 py-10 text-center">
            <p className="font-medium text-ink">還沒有專案</p>
            <p className="mt-1 text-[13px] text-ink-3">連接設計資料夾之後，專案會出現在這裡。</p>
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {projects.data.map((p) => (
              <button
                key={p.projectId}
                type="button"
                onClick={() => navigate({ name: 'project', projectId: p.projectId })}
                className="flex w-full items-center gap-4 px-5 py-3.5 text-left first:rounded-t-lg last:rounded-b-lg hover:bg-raised"
              >
                <Folder className="size-5 shrink-0 text-tide-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{p.name || '未命名專案'}</span>
                  <span className="block truncate text-[12px] text-ink-3">{p.root}</span>
                </span>
                <span className="text-[12px] text-ink-3">{formatWhen(p.boundAt)} 連接</span>
                <ChevronDown className="size-4 -rotate-90 text-ink-3" />
              </button>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
