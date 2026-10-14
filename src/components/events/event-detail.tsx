"use client";

import { localizeEvent } from "@/i18n/event-format";
import { useI18n } from "@/i18n/provider";
import type { ReactNode } from "react";
import { ChevronDown, Clock3, Hourglass, Info, Link2 } from "lucide-react";
import { cn } from "cn";

import { CameraBadge } from "@/components/events/camera-badge";
import { ClipCard } from "@/components/events/clip-card";
import { DetectionBadge, DetectionBadgeList } from "@/components/events/detection-badge";
import { GroupingBadge } from "@/components/events/grouping-badge";
import { MetadataStatusBadge } from "@/components/events/metadata-status-badge";
import { ClipPlayer } from "@/components/events/clip-player";
import { eventTitle } from "@/lib/event-title";
import { formatBytes, formatDurationLong } from "@/lib/format";
import { GROUPING_DESCRIPTION_KEYS, METADATA_DESCRIPTION_KEYS } from "@/lib/labels";
import type { EventDetailModel } from "@/lib/view-models";

interface EventDetailProps {
  event: EventDetailModel;
  /** `page` renders the title as h1, `panel` as h2 with tighter spacing. */
  variant?: "page" | "panel";
  /** Rendered next to the title (e.g. "open full page"). */
  actions?: ReactNode;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="surface-inset flex flex-col gap-1 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-[0.9375rem] font-medium">{children}</dd>
    </div>
  );
}

function TechRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function EventDetail({ event, variant = "page", actions }: EventDetailProps) {
  const { t, locale } = useI18n();
  event = localizeEvent(event, locale);
  const isPage = variant === "page";
  const Title = isPage ? "h1" : "h2";
  const SectionTitle = isPage ? "h2" : "h3";

  return (
    <article className={cn("flex flex-col", isPage ? "gap-6" : "gap-5")}>
      <ClipPlayer
        key={event.id}
        clips={event.clips}
        cameraName={event.cameras.map((camera) => camera.unknown ? t("cameras.unknown") : camera.name).join(" · ")}
        pending={event.status === "pendingClip"}
        framed={isPage}
      />

      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">
              {event.dayLabel} · {event.timeLabel} {t("events.clockSuffix")}
            </p>
            <Title className={cn("font-semibold tracking-tight", isPage ? "text-2xl sm:text-3xl" : "text-xl")}>
              {eventTitle(event, t)}
            </Title>
          </div>
          {actions}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <DetectionBadgeList types={event.detectionTypes} className="contents" />
          <MetadataStatusBadge status={event.status} />
          <GroupingBadge kind={event.grouping} />
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label={t("common.cameras")}>
          {event.cameras.map((camera) => (
            <CameraBadge key={camera.key} name={camera.unknown ? t("cameras.unknown") : camera.name} />
          ))}
        </div>
      </header>

      <dl className={cn("grid gap-2.5", isPage ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2")}>
        <Fact label={t("common.start")}>
          <span className="tabular-nums">{event.startLabel}</span>
        </Fact>
        <Fact label={t("common.end")}>
          <span className="tabular-nums">{event.endLabel ?? t("common.ongoing")}</span>
        </Fact>
        <Fact label={t("common.duration")}>{event.durationSeconds !== null ? formatDurationLong(event.durationSeconds, locale) : "–"}</Fact>
        <Fact label={t("common.recordings")}>
          {t("counts.clips", { count: event.clipCount })} · {t("counts.detections", { count: event.protectEventCount })}
        </Fact>
      </dl>

      <p className="flex gap-3 rounded-[var(--radius-control)] bg-pastel-blue px-4 py-3 text-sm text-pastel-blue-ink">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t(METADATA_DESCRIPTION_KEYS[event.status])}
      </p>

      {event.grouping && (
        <section className="surface-inset flex flex-col gap-2.5 px-4 py-3 text-sm" aria-label={t("events.cameraGrouping")}>
          <p className="flex gap-3 text-muted-foreground">
            {event.grouping === "temporal" ? (
              <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Link2 aria-hidden className="mt-0.5 size-4 shrink-0" />
            )}
            {t(GROUPING_DESCRIPTION_KEYS[event.grouping])}
          </p>
          {/* Per part: never claim Protect confirmed a camera it did not report. */}
          {event.groupingParts.length > 1 && (
            <ul className="flex flex-col divide-y divide-border/70">
              {event.groupingParts.map((part) => (
                <li key={part.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5">
                  <span className="min-w-0 font-medium">{part.cameras.map((camera, index) => part.unknownCameras?.includes(index) ? t("cameras.unknown") : camera).join(" · ")}</span>
                  <span className="text-xs text-muted-foreground">
                    {part.confirmed ? t("events.protectDetection") : t("events.temporalPart")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label={t("common.recordings")}>
        <SectionTitle className="text-base font-semibold">
          {event.clips.length === 1 ? t("common.recording") : t("events.recordingCount", { count: event.clips.length })}
        </SectionTitle>
        {event.clips.length === 0 ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-control)] bg-warning-soft px-4 py-3 text-sm text-warning-strong">
            <Hourglass aria-hidden className="size-5 shrink-0" />
            <p>{t("events.pendingBody")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {event.clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} />
            ))}
          </div>
        )}
      </section>

      <details className="group surface-inset px-4 py-1 text-sm">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {t("events.technical")}<ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-4 pb-3">
          <dl className="divide-y divide-border/70">
            <TechRow label={t("events.archiveEvent")}>{event.id}</TechRow>
          </dl>
          {event.clips.map((clip) => (
            <dl key={clip.id} className="divide-y divide-border/70">
              <TechRow label={t("common.clip")}>{clip.label}</TechRow>
              <TechRow label={t("common.file")}>{clip.fileName}</TechRow>
              <TechRow label={t("common.path")}>{clip.filePath}</TechRow>
              <TechRow label={t("common.size")}>{clip.fileSizeBytes !== null ? formatBytes(clip.fileSizeBytes, locale) : t("common.unknown")}</TechRow>
              <TechRow label={t("common.period")}>
                {clip.startLabel} – {clip.endLabel}
              </TechRow>
            </dl>
          ))}
          {event.protectEvents.map((pe) => (
            <dl key={pe.protectEventId} className="divide-y divide-border/70">
              <TechRow label={t("events.protectEvent")}>{pe.protectEventId}</TechRow>
              <TechRow label={t("common.type")}>{pe.eventType}</TechRow>
              <TechRow label={t("common.camera")}>{pe.unknownCamera ? t("cameras.unknown") : pe.cameraName}</TechRow>
              <TechRow label={t("status.matched")}>
                <span className="flex flex-wrap gap-1 font-sans">
                  {pe.detectionTypes.length > 0
                    ? pe.detectionTypes.map((type) => <DetectionBadge key={type} type={type} size="sm" />)
                    : "–"}
                </span>
              </TechRow>
              <TechRow label={t("common.period")}>
                {pe.startLabel} – {pe.endLabel ?? t("common.runningShort")}
              </TechRow>
            </dl>
          ))}
        </div>
      </details>
    </article>
  );
}
