"use client";

import { useI18n } from "@/i18n/provider";
import { cn } from "cn";

import { detectionStyle } from "@/components/events/detection-badge";
import { formatNumber } from "@/lib/format";
import { detectionLabel } from "@/lib/labels";

/** Compact bars: archive events per detection type (count is always shown as text). */
export function DetectionDistribution({ counts }: { counts: readonly { type: string; count: number }[] }) {
  const { t, locale } = useI18n();
  if (counts.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("dashboard.noTypes")}</p>;
  }
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  return (
    <ul className="flex flex-col gap-4">
      {counts.map(({ type, count }) => {
        const { icon: Icon, badge, solid } = detectionStyle(type);
        return (
          <li key={type} className="flex items-center gap-3">
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-sm", badge)}>
              <Icon aria-hidden className="size-4.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{detectionLabel(type, t)}</span>
                <span className="font-medium tabular-nums">{formatNumber(count, locale)}</span>
              </div>
              <div aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <div className={cn("h-full rounded-full", solid)} style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
