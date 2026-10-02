import type { ReactNode } from 'react';
import type { ConnectionState } from '../../shared/bridge.ts';
import { cn } from '../lib/cn.ts';
import type { Route } from '../lib/route.ts';
import { Alert, Cloud, Gear, Layers, TideMark } from './icons.tsx';
import { OperationBanners } from './operation-banners.tsx';
import { Button } from './ui/button.tsx';

type Section = 'projects' | 'account' | 'settings';

const NAV: { section: Section; route: Route; label: string; icon: ReactNode }[] = [
  { section: 'projects', route: { name: 'home' }, label: '專案', icon: <Layers /> },
  { section: 'account', route: { name: 'account' }, label: '帳號與同步', icon: <Cloud /> },
  { section: 'settings', route: { name: 'settings' }, label: '設定與診斷', icon: <Gear /> },
];

function sectionOf(route: Route): Section {
  if (route.name === 'account' || route.name === 'settings') return route.name;
  return 'projects';
}

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
  route,
  onNavigate,
  connection,
  onRetry,
  children,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  connection: ConnectionState;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-6 border-b border-line bg-surface px-5">
        <button
          type="button"
          onClick={() => onNavigate({ name: 'home' })}
          className="flex items-center gap-2 rounded-md py-1 pr-2 text-[15px] font-semibold tracking-tight text-ink"
          aria-label="Draft Tide：專案"
        >
          <TideMark />
          Draft Tide
        </button>
        <nav aria-label="主要" className="flex items-center gap-1">
          {NAV.map((item) => (
            <Button
              key={item.section}
              variant="ghost"
              size="sm"
              aria-current={sectionOf(route) === item.section ? 'page' : undefined}
              className={cn(sectionOf(route) === item.section && 'bg-sunken text-ink')}
              onClick={() => onNavigate(item.route)}
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
      {connection.status === 'connected' && <OperationBanners route={route} navigate={onNavigate} />}
      <main className="dt-scroll min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
