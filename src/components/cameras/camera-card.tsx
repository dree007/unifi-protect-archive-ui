"use client";

import { useI18n } from "@/i18n/provider";
import { Cctv, Wifi, WifiOff } from "lucide-react";
import { cn } from "cn";

import { TONE_CLASSES } from "@/components/common/tone";
import { DetectionBadge } from "@/components/events/detection-badge";
import { formatBytes, formatNumber } from "@/lib/format";
import type { CameraViewModel } from "@/lib/view-models";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-inset flex flex-col gap-0.5 px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

export function CameraCard({ camera }: { camera: CameraViewModel }) {
  const { t, locale } = useI18n();
  const headingId = `camera-${camera.id}`;
  return (
    <article aria-labelledby={headingId} className="surface-card flex w-full flex-col gap-5 p-5">
      <header className="flex items-start gap-3.5">
        <span
          aria-hidden
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-sm",
            camera.online ? "bg-sky-soft text-sky-ink" : "bg-stone text-graphite",
          )}
        >
          <Cctv className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="truncate type-heading">
            {camera.name}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {camera.lastClipLabel ? t("cameras.lastRecording", { time: camera.lastClipLabel }) : t("cameras.noClips")}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[0.8125rem] font-medium",
            // Offline is a calm, clearly labelled state – not an alarm that colors the whole card.
            camera.online ? TONE_CLASSES.success : TONE_CLASSES.warning,
          )}
        >
          {camera.online ? <Wifi aria-hidden className="size-4" /> : <WifiOff aria-hidden className="size-4" />}
          {camera.online ? t("common.online") : t("common.offline")}
        </span>
      </header>

      {!camera.online && (
        <p className="surface-inset px-4 py-3 text-sm text-muted-foreground">
          {camera.lastSeenLabel ? t("cameras.lastSeen", { time: camera.lastSeenLabel }) : t("cameras.neverConnected")}{" "}
          {t("cameras.existingClips")}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-graphite">{t("cameras.smartDetections")}</h3>
        {camera.smartDetectTypes.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {camera.smartDetectTypes.map((type) => (
              <DetectionBadge key={type} type={type} size="sm" />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("cameras.noTypes")}</p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <Metric label={t("common.today")} value={formatNumber(camera.clipsToday, locale)} />
        <Metric label={t("common.clips")} value={formatNumber(camera.clipCount, locale)} />
        <Metric label={t("common.storage")} value={formatBytes(camera.storageBytes, locale)} />
      </dl>

      <dl className="mt-auto grid gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
        {camera.protectStateLabel && (
          <>
            <dt>{t("cameras.protectStatus")}</dt>
            <dd className="text-graphite">{camera.protectStateLabel === "Connected" ? t("status.connected") : camera.protectStateLabel === "Disconnected" ? t("status.disconnected") : camera.protectStateLabel === "Firmware updating" ? t("status.firmwareUpdating") : camera.protectStateLabel}</dd>
          </>
        )}
        <dt>{t("cameras.deviceId")}</dt>
        <dd className="font-mono [overflow-wrap:anywhere]">{camera.protectDeviceId}</dd>
        {camera.mac && (
          <>
            <dt>MAC</dt>
            <dd className="font-mono">{camera.mac}</dd>
          </>
        )}
      </dl>
    </article>
  );
}
