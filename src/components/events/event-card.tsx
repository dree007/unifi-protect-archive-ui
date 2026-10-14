"use client";

import { localizeEvent } from "@/i18n/event-format";
import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import type { MouseEventHandler } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "cn";

import { CameraBadgeList } from "@/components/events/camera-badge";
import { DetectionBadgeList } from "@/components/events/detection-badge";
import { GroupingBadge } from "@/components/events/grouping-badge";
import { MetadataStatusBadge } from "@/components/events/metadata-status-badge";
import { EventPreview } from "@/components/events/event-preview";
import { eventTitle } from "@/lib/event-title";
import type { EventCardModel } from "@/lib/view-models";

interface EventCardProps {
  event: EventCardModel;
  href: string;
  /** Show the date next to the time (lists without day headings). */
  showDate?: boolean;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
}

/**
 * One archive event. The thumbnail is the main element: on phones a compact row (large
 * thumbnail left, quick to scroll), from `md` a vertical card with a full-width preview.
 * Metadata stays calm – time, title, cameras, detections; the duration sits on the preview.
 */
export function EventCard({ event, href, showDate = false, selected, onClick, className }: EventCardProps) {
  const { t, locale } = useI18n();
  event = localizeEvent(event, locale);
  const title = eventTitle(event, t);
  const when = showDate ? event.whenLabel : event.timeLabel;
  const cameraNames = event.cameras.map((camera) => camera.unknown ? t("cameras.unknown") : camera.name).join(", ");

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      aria-label={`${title}, ${when}${cameraNames ? `, ${cameraNames}` : ""}`}
      className={cn(
        "surface-card-interactive group flex gap-3.5 p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring md:flex-col md:gap-3",
        selected && "shadow-[var(--shadow-elevated)] ring-2 ring-selected-foreground/30",
        className,
      )}
    >
      <EventPreview event={event} className="w-32 shrink-0 self-start md:aspect-[16/10] md:w-full" />

      <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5 md:px-1 md:pb-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[1.0625rem] leading-tight font-semibold tracking-tight tabular-nums">{when}</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {title}
              {event.clipCount > 1 && <span className="tabular-nums"> · {event.clipCount} {t("common.clips")}</span>}
            </p>
          </div>
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          />
        </div>

        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5">
          <CameraBadgeList cameras={event.cameras} size="sm" className="contents" />
          {event.status === "matched" && <DetectionBadgeList types={event.detectionTypes} size="sm" className="contents" />}
          {/* Archive-only events already say „Archivclip“ in the title; pending is worth a badge. */}
          {event.status === "pendingClip" && <MetadataStatusBadge status={event.status} size="sm" />}
          <GroupingBadge kind={event.grouping} size="sm" />
        </div>
      </div>
    </Link>
  );
}
