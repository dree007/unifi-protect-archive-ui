"use client";

import { useI18n } from "@/i18n/provider";
import { HardDrive } from "lucide-react";

import { ClipThumbnail } from "@/components/events/clip-thumbnail";
import { VideoPreview } from "@/components/events/video-preview";
import { formatBytes, formatDuration } from "@/lib/format";
import type { ClipModel } from "@/lib/view-models";

/** One recording of an event (main view; file paths live in the technical details). */
export function ClipCard({ clip }: { clip: ClipModel }) {
  const { t, locale } = useI18n();
  return (
    <article className="surface-inset flex gap-3.5 p-3">
      <VideoPreview
        cameraName={clip.cameraName}
        durationSeconds={clip.durationSeconds}
        label={t("events.thumbnail", { label: clip.label })}
        className="w-24 shrink-0 self-start sm:w-28"
      >
        <ClipThumbnail key={clip.thumbnailUrl} src={clip.thumbnailUrl} />
      </VideoPreview>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate font-semibold">{clip.label}</p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {clip.startLabel} – {clip.endLabel} · {formatDuration(clip.durationSeconds, locale)}
        </p>
        {clip.fileSizeBytes !== null && (
          <p className="mt-auto inline-flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            <HardDrive aria-hidden className="size-4" />
            <span className="sr-only">{t("events.sizePrefix")}</span>
            {formatBytes(clip.fileSizeBytes, locale)}
          </p>
        )}
      </div>
    </article>
  );
}
