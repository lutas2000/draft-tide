import type { ReactNode } from 'react';
import type { ConnectionState } from '../../shared/bridge.ts';
import { cn } from '../lib/cn.ts';
import { Alert, Cloud, Gear, Layers, TideMark } from './icons.tsx';
import { Button } from './ui/button.tsx';

export type Screen = 'projects' | 'account' | 'settings';

const NAV: { screen: Screen; label: string; icon: ReactNode }[] = [
  { screen: 'projects', label: '專案', icon: <Layers /> },
  { screen: 'account', label: '帳號與同步', icon: <Cloud /> },
  { screen: 'settings', label: '設定與診斷', icon: <Gear /> },
];

function ConnectionDot({ state }: { state: ConnectionState }) {
  const [tone, label] =
    state.status === 'connected'
      ? ['bg-ok', '引擎已連線']
      : state.status === 'connecting'
        ? ['bg-warn', '正在連線引擎…']
        : ['bg-danger', '引擎未連線'];
  return (
    <span className="flex items-center gap-2 text-[12px] text-ink-3" role="status" aria-live="polite">
      <span className={cn('size-2 rounded-full', tone)} />
      {label}
    </span>
  );
}

export function AppShell({
  screen,
  onNavigate,
  connection,
  onRetry,
  children,
}: {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  connection: ConnectionState;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-6 border-b border-line bg-surface px-5">
        <button
          type="button"
          onClick={() => onNavigate('projects')}
          className="flex items-center gap-2 rounded-md py-1 pr-2 text-[15px] font-semibold tracking-tight text-ink"
          aria-label="Draft Tide：專案"
        >
          <TideMark />
          Draft Tide
        </button>
        <nav aria-label="主要" className="flex items-center gap-1">
          {NAV.map((item) => (
            <Button
              key={item.screen}
              variant="ghost"
              size="sm"
              aria-current={screen === item.screen ? 'page' : undefined}
              className={cn(screen === item.screen && 'bg-sunken text-ink')}
              onClick={() => onNavigate(item.screen)}
            >
              {item.icon}
              {item.label}
            </Button>
          ))}
        </nav>
        <div className="ml-auto">
          <ConnectionDot state={connection} />
        </div>
      </header>
      {connection.status === 'unavailable' && (
        <div
          className="flex items-center gap-3 border-b border-warn-line bg-warn-soft px-5 py-2.5 text-[13px] text-warn"
          role="alert"
        >
          <Alert className="size-4 shrink-0" />
          <span className="flex-1">無法連線到 Draft Tide 引擎。設計檔案與歷史不受影響，連線恢復後即可繼續。</span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            重試
          </Button>
        </div>
      )}
      <main className="dt-scroll min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
