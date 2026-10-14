"use client";
import { useI18n } from "@/i18n/provider";
import { Cctv } from "lucide-react";
import { cn } from "cn";

import type { CameraRef } from "@/lib/view-models";

export function CameraBadge({
  name,
  size = "md",
  className,
  ...props
}: { name: string; size?: "sm" | "md"; className?: string; "aria-label"?: string }) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full bg-surface-muted font-medium text-foreground/85",
        size === "sm" ? "h-6 pr-2.5 pl-2 text-xs" : "h-7 pr-3 pl-2.5 text-[0.8125rem]",
        className,
      )}
    >
      <Cctv aria-hidden className={cn("shrink-0 text-muted-foreground", size === "sm" ? "size-3.5" : "size-4")} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Camera chips; beyond `max` cameras a "+N" chip keeps cards compact. */
export function CameraBadgeList({
  cameras,
  size,
  max = 3,
  className,
}: {
  cameras: readonly CameraRef[];
  size?: "sm" | "md";
  max?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const shown = cameras.length > max ? cameras.slice(0, max - 1) : cameras;
  const hidden = cameras.length - shown.length;
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {shown.map((camera) => (
        <CameraBadge key={camera.key} name={camera.unknown ? t("cameras.unknown") : camera.name} size={size} />
      ))}
      {hidden > 0 && (
        <CameraBadge
          name={`+${hidden}`}
          size={size}
          className="tabular-nums"
          aria-label={t("events.moreCameras", { count: hidden, names: cameras.slice(shown.length).map((c) => c.unknown ? t("cameras.unknown") : c.name).join(", ") })}
        />
      )}
    </div>
  );
}
