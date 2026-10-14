"use client";

import { useI18n } from "@/i18n/provider";
import { cn } from "cn";

import { ClipThumbnail } from "@/components/events/clip-thumbnail";
import { VideoPreview } from "@/components/events/video-preview";
import type { EventCardModel } from "@/lib/view-models";

/**
 * Preview of an event card: the representative clip's thumbnail, or two thumbnails side by
 * side for events with exactly two cameras. Pending events show the "Aufnahme ausstehend"
 * placeholder and never request an image.
 */
export function EventPreview({ event, className }: { event: EventCardModel; className?: string }) {
  const { t } = useI18n();
  const pending = event.status === "pendingClip" || event.previews.length === 0;
  const cameraNames = event.previews.map((preview) => preview.cameraName).join(" · ");
  return (
    <VideoPreview
      cameraName={event.previews[0]?.cameraName ?? (event.cameras[0]?.unknown ? t("cameras.unknown") : event.cameras[0]?.name) ?? ""}
      durationSeconds={event.durationSeconds}
      pending={pending}
      label={pending ? t("status.pendingClip") : t("events.thumbnail", { label: cameraNames })}
      className={className}
    >
      {!pending && (
        <div className={cn("absolute inset-0 grid", event.previews.length === 2 ? "grid-cols-2 gap-px" : "grid-cols-1")}>
          {event.previews.map((preview) => (
            <div key={preview.clipId} className="relative overflow-hidden">
              <ClipThumbnail key={preview.thumbnailUrl} src={preview.thumbnailUrl} />
            </div>
          ))}
        </div>
      )}
    </VideoPreview>
  );
}
