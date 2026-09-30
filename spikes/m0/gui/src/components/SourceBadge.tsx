import type { SnapshotKind } from '../mock/types';
import { Badge, type BadgeTone } from './ui/Badge';
import { Bot, Flag, Pencil, Restore, Shield } from './Icons';

const map: Record<SnapshotKind, { label: string; tone: BadgeTone; Icon: typeof Bot }> = {
  baseline: { label: '第一版', tone: 'baseline', Icon: Flag },
  manual: { label: '手動保存', tone: 'neutral', Icon: Pencil },
  'agent-requested': { label: '由 Agent 請求', tone: 'agent', Icon: Bot },
  'pre-restore': { label: '回復前保護', tone: 'protect', Icon: Shield },
  restore: { label: '回復版本', tone: 'restore', Icon: Restore },
};

export function sourceLabel(kind: SnapshotKind): string {
  return map[kind].label;
}

export function SourceBadge({ kind }: { kind: SnapshotKind }) {
  const { label, tone, Icon } = map[kind];
  return (
    <Badge tone={tone} icon={<Icon className="size-3" />}>
      {label}
    </Badge>
  );
}
