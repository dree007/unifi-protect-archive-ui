"use client";

import { useI18n } from "@/i18n/provider";
import type { ReactNode } from "react";
import { Film, Hourglass } from "lucide-react";
import { cn } from "cn";

import { formatDuration } from "@/lib/format";

interface VideoPreviewProps {
  cameraName: string;
  durationSeconds?: number | null;
  /** No clip in the archive yet (Protect event without recording). */
  pending?: boolean;
  variant?: "thumbnail" | "player";
  /** Accessible name; defaults to a description of the placeholder. */
  label?: string;
  /** Laid over the placeholder, e.g. thumbnail images (which fall back to it on errors). */
  children?: ReactNode;
  className?: string;
}

/**
 * Fixed-geometry preview area: a calm, camera-specific placeholder, optionally with thumbnail
 * images on top (`children`). Deliberately without a play button – cards never play inline.
 */
export function VideoPreview({
  cameraName,
  durationSeconds,
  pending = false,
  variant = "thumbnail",
  label: labelOverride,
  children,
  className,
}: VideoPreviewProps) {
  const { t, locale } = useI18n();
  const isPlayer = variant === "player";
  const label =
    labelOverride ??
    (pending
      ? t("events.pendingCamera", { camera: cameraName })
      : t("events.preview", { camera: cameraName, unavailable: isPlayer ? t("events.unavailableSuffix") : "" }));
  const Icon = pending ? Hourglass : Film;

  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        // Flat placeholder (Atelier Soft has no gradients here): stone, ember tint while pending.
        "relative isolate overflow-hidden",
        pending ? "bg-warning-soft text-warning-strong" : "bg-stone text-graphite",
        isPlayer ? "aspect-video rounded-card" : "aspect-[4/3] rounded-sm",
        className,
      )}
    >
      <div className="absolute inset-0 grid place-items-center">
        <span className="flex flex-col items-center gap-2 text-center">
          <Icon aria-hidden className={cn("opacity-60", isPlayer ? "size-8" : "size-5")} />
          {isPlayer && (
            <span className="px-4 text-sm font-medium opacity-90">
              {pending ? t("status.pendingClip") : t("events.noRecording")}
            </span>
          )}
        </span>
      </div>

      {children}

      {isPlayer && (
        <span className="absolute top-4 left-4 max-w-[70%] truncate rounded-full bg-card/90 px-3 py-1 text-xs font-medium text-foreground shadow-soft-sm">
          {cameraName}
        </span>
      )}
      {durationSeconds !== undefined && durationSeconds !== null && (
        <span
          className={cn(
            // Readable on any thumbnail: a small, nearly opaque eggshell pill with ink text.
            "absolute z-10 rounded-full bg-card/90 font-medium text-foreground tabular-nums shadow-soft-sm",
            isPlayer ? "right-4 bottom-4 px-2.5 py-0.5 text-sm" : "right-2 bottom-2 px-2 py-0.5 text-xs",
          )}
        >
          {formatDuration(durationSeconds, locale)}
        </span>
      )}
    </div>
  );
}
