"use client";
import { useI18n } from "@/i18n/provider";
import { Clock3, Link2 } from "lucide-react";
import { cn } from "cn";

import { GROUPING_DESCRIPTION_KEYS, GROUPING_KEYS } from "@/lib/labels";
import type { GroupingKind } from "@/lib/view-models";

const STYLES: Record<GroupingKind, { icon: typeof Clock3; className: string }> = {
  // Quiet outline: the normal case for several cameras with Protect detections.
  metadata: { icon: Link2, className: "border border-line text-graphite" },
  // Soft neutral fill: grouped by time only – noticeable, but not a warning.
  temporal: { icon: Clock3, className: "bg-neutral-soft text-neutral-strong" },
};

/**
 * Why several cameras form one event: "Erkennungen abgeglichen" or "Zeitlich zugeordnet".
 * Only rendered for multi-camera events (`kind` is `null` otherwise).
 */
export function GroupingBadge({
  kind,
  size = "md",
  className,
}: {
  kind: GroupingKind | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const { t } = useI18n();
  if (!kind) return null;
  const { icon: Icon, className: style } = STYLES[kind];
  return (
    <span
      title={t(GROUPING_DESCRIPTION_KEYS[kind])}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 pr-2.5 pl-2 text-xs" : "h-7 pr-3 pl-2.5 text-[0.8125rem]",
        style,
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3.5" : "size-4"} />
      {t(GROUPING_KEYS[kind])}
    </span>
  );
}
