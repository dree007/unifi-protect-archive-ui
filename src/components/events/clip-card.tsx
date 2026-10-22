"use client";

import { useI18n } from "@/i18n/provider";
import { FileX, HardDrive } from "lucide-react";

import { ClipThumbnail } from "@/components/events/clip-thumbnail";
import { VideoPreview } from "@/components/events/video-preview";
import { formatBytes, formatDuration } from "@/lib/format";
import type { ClipModel } from "@/lib/view-models";

/**
 * One recording of an event (main view; file paths live in the technical details). Favorites
 * and collections belong to the whole event (EventCuration), not to a single recording.
 */
export function ClipCard({ clip }: { clip: ClipModel }) {
  const { t, locale } = useI18n();
  return (
    <article className="surface-inset flex flex-col gap-2 p-3">
      <div className="flex gap-3.5">
        <VideoPreview
          cameraName={clip.cameraName}
          durationSeconds={clip.durationSeconds}
          label={t("events.thumbnail", { label: clip.label })}
          className="w-24 shrink-0 self-start sm:w-28"
        >
          <ClipThumbnail key={clip.thumbnailUrl} src={clip.thumbnailUrl} />
        </VideoPreview>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate font-medium">{clip.label}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {clip.startLabel} – {clip.endLabel} · {formatDuration(clip.durationSeconds, locale)}
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted-foreground">
            {clip.fileSizeBytes !== null && (
              <p className="inline-flex items-center gap-1.5">
                <HardDrive aria-hidden className="size-4" />
                <span className="sr-only">{t("events.sizePrefix")}</span>
                {formatBytes(clip.fileSizeBytes, locale)}
              </p>
            )}
          </div>
        </div>
      </div>
      {clip.missing && (
        <p className="flex gap-2.5 rounded-sm bg-warning-soft px-3 py-2 text-sm text-warning-strong">
          <FileX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{t("events.fileMissing")}.</span> {t("events.fileMissingBody")}
          </span>
        </p>
      )}
    </article>
  );
}
