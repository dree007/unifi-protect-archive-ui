"use client";

import { useI18n } from "@/i18n/provider";
import type { ReactNode } from "react";
import { Film, Hourglass } from "lucide-react";
import { cn } from "cn";

import { formatDuration } from "@/lib/format";

/** Soft pastel, camera-specific gradients so placeholders are distinguishable but calm. */
const SCENE_GRADIENTS = [
  "from-pastel-lavender via-pastel-blue to-pastel-sky",
  "from-pastel-blue via-pastel-lavender to-pastel-blush",
  "from-pastel-mint via-pastel-sky to-pastel-blue",
  "from-pastel-blush via-pastel-peach to-pastel-lavender",
  "from-pastel-neutral via-pastel-blue to-pastel-mint",
] as const;

function sceneGradient(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SCENE_GRADIENTS[hash % SCENE_GRADIENTS.length];
}

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
        "relative isolate overflow-hidden bg-gradient-to-br text-pastel-neutral-ink",
        pending ? "from-pastel-peach via-pastel-neutral to-pastel-neutral" : sceneGradient(cameraName),
        isPlayer ? "aspect-video rounded-[var(--radius-card)]" : "aspect-[4/3] rounded-[var(--radius-inner)]",
        className,
      )}
    >
      {/* Soft light from the top right; never a dark veil over the thumbnail. */}
      <div aria-hidden className="absolute -top-1/3 -right-1/4 size-2/3 rounded-full bg-card/40 blur-2xl" />

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
        <span className="absolute top-4 left-4 max-w-[70%] truncate rounded-full bg-card/80 px-3 py-1 text-xs font-medium text-foreground shadow-[var(--shadow-control)] backdrop-blur-sm">
          {cameraName}
        </span>
      )}
      {durationSeconds !== undefined && durationSeconds !== null && (
        <span
          className={cn(
            // Readable on any thumbnail: a small frosted white pill with ink text.
            "absolute z-10 rounded-full bg-card/85 font-medium text-foreground tabular-nums shadow-[var(--shadow-control)] backdrop-blur-sm",
            isPlayer ? "right-4 bottom-4 px-2.5 py-0.5 text-sm" : "right-2 bottom-2 px-2 py-0.5 text-xs",
          )}
        >
          {formatDuration(durationSeconds, locale)}
        </span>
      )}
    </div>
  );
}
