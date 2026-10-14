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
  const Icon = primary ? detectionStyle(primary).icon : Sparkles;

  return (
    <section
      aria-labelledby="latest-detection"
      className={cn(
        "relative isolate flex flex-col justify-between gap-6 overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-br from-pastel-lavender via-pastel-blue to-pastel-sky p-5 text-foreground shadow-[var(--shadow-card)] sm:p-7",
        className,
      )}
    >
      {/* Soft light, no strong glow. */}
      <div aria-hidden className="absolute -top-20 -right-12 -z-10 size-64 rounded-full bg-card/55 blur-3xl" />
      <div aria-hidden className="absolute -bottom-24 -left-12 -z-10 size-56 rounded-full bg-pastel-blush/60 blur-3xl" />

      <div className="flex items-center justify-between gap-3">
        <h2 id="latest-detection" className="text-sm font-medium text-pastel-lavender-ink">
          {t("dashboard.latest")}
        </h2>
        <span className="grid size-11 place-items-center rounded-[var(--radius-control)] bg-card/80 text-pastel-lavender-ink shadow-[var(--shadow-control)]">
          <Icon aria-hidden className="size-5" />
        </span>
      </div>

      {detection && primary ? (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
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
              className="inline-flex h-11 items-center gap-1.5 rounded-full bg-card px-5 text-sm font-semibold text-selected-foreground shadow-[var(--shadow-control)] transition-[background-color,box-shadow] duration-200 outline-none hover:shadow-[var(--shadow-card)] focus-visible:ring-3 focus-visible:ring-ring"
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
