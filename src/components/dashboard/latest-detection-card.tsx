"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { cn } from "cn";

import { detectionStyle } from "@/components/events/detection-badge";
import { detectionLabel } from "@/lib/labels";
import type { LatestDetectionModel } from "@/lib/view-models";

/** Prominent summary of the newest archive event with a smart detection. */
export function LatestDetectionCard({ detection, className }: { detection: LatestDetectionModel | null; className?: string }) {
  const { t } = useI18n();
  const [primary] = detection?.detectionTypes ?? [];
  const style = primary ? detectionStyle(primary) : null;
  const Icon = style?.icon ?? Sparkles;

  return (
    <section
      aria-labelledby="latest-detection"
      className={cn(
        // The hero card: a 32 px radius and only the light top edge, tinted in the pastel hue of
        // the newest detection (warm taupe without one).
        "flex flex-col justify-between gap-6 rounded-card-lg p-5 text-foreground shadow-highlight sm:p-7",
        style?.surface ?? "bg-surface-muted",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="latest-detection" className="text-sm font-medium text-graphite">
          {t("dashboard.latest")}
        </h2>
        <span className={cn("grid size-11 place-items-center rounded-full bg-card", style?.ink ?? "text-ink")}>
          <Icon aria-hidden className="size-5" />
        </span>
      </div>

      {detection && primary ? (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="type-title text-foreground">
              {detection.detectionTypes.map((type) => detectionLabel(type, t)).join(" · ")}
            </p>
            <p className="truncate text-base text-muted-foreground">
              {detection.cameras.map((camera) => camera.unknown ? t("cameras.unknown") : camera.name).join(" · ") || t("cameras.unknown")} · {detection.relativeLabel}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-muted-foreground tabular-nums">{detection.timeLabel} {t("events.clockSuffix")}</span>
            <Link
              href={`/archive/${detection.eventId}`}
              className="inline-flex h-11 items-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-ink transition-[background-color,transform] duration-200 outline-none hover:bg-primary-hover focus-ring active:translate-y-px"
            >
              {t("common.view")}<ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </div>
        </>
      ) : (
        <p className="text-base text-muted-foreground">
          {t("dashboard.noDetection")}
        </p>
      )}
    </section>
  );
}
