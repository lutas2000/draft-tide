import { Cloud } from '../components/icons.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';

export function AccountScreen() {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-page pt-10 pb-24">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">帳號與同步</h1>
        <p className="mt-1 text-ink-2">
          登入 GitHub 是可略過的選項。略過或離線時，所有本機功能照常使用，保存不會等待網路。
        </p>
      </div>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Cloud className="size-4 text-ink-3" />
              GitHub 登入與同步
            </span>
          }
          description="把專案同步到你自己的 private repo，並在其他資料夾或電腦開啟。"
          action={<Badge tone="outline">尚未提供</Badge>}
        />
        <CardBody>
          <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
            目前所有專案都只在這台電腦上：沒有同步到遠端的專案沒有異地備份。
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
