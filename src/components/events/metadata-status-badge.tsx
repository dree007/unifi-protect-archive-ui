"use client";
import { useI18n } from "@/i18n/provider";
import { Film, Hourglass, Sparkles } from "lucide-react";
import { cn } from "cn";

import { TONE_CLASSES, type Tone } from "@/components/common/tone";
import type { MetadataStatus } from "@/domain/types";
import { METADATA_STATUS_KEYS } from "@/lib/labels";

const STATUS_STYLES: Record<MetadataStatus, { icon: typeof Sparkles; tone: Tone }> = {
  matched: { icon: Sparkles, tone: "primary" },
  archiveOnly: { icon: Film, tone: "neutral" },
  pendingClip: { icon: Hourglass, tone: "warning" },
};

/** Human-friendly status pill: "Erkennung", "Archivclip", "Aufnahme ausstehend". */
export function MetadataStatusBadge({
  status,
  size = "md",
  className,
}: {
  status: MetadataStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const { t } = useI18n();
  const { icon: Icon, tone } = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 pr-2.5 pl-2 text-xs" : "h-7 pr-3 pl-2.5 text-[0.8125rem]",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3.5" : "size-4"} />
      {t(METADATA_STATUS_KEYS[status])}
    </span>
  );
}
