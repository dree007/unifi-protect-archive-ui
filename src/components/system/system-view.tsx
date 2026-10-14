"use client";

import { operationError } from "@/i18n/errors";
import { useI18n } from "@/i18n/provider";
import { Database, HardDrive } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { PageHeader } from "@/components/layout/page-header";
import { JOB_BADGES, PROTECT_BADGES, SCAN_RUN_BADGES, WORKER_BADGES } from "@/components/system/status-badges";
import { Facts, Metric, Notice, StatusPill, type StatusBadge } from "@/components/system/status-parts";
import { StatusRefresh } from "@/components/system/status-refresh";
import type { MetadataStatus } from "@/domain/types";
import { formatBytes, formatNumber } from "@/lib/format";
import { METADATA_STATUS_KEYS } from "@/lib/labels";
import type { BackgroundStatusModel, ScanRunModel, SystemStatusModel } from "@/lib/view-models";

const REFRESH_INTERVAL_MS = 30_000;

function ScanRun({ run }: { run: ScanRunModel }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill badge={{ ...SCAN_RUN_BADGES[run.status], label: t(SCAN_RUN_BADGES[run.status].label) }} />
        <span className="text-sm text-muted-foreground">{run.relativeLabel}</span>
      </div>
      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label={t("common.files")} value={formatNumber(run.filesFound, locale)} />
        <Metric label={t("common.new")} value={formatNumber(run.discovered, locale)} />
        <Metric label={t("common.updated")} value={formatNumber(run.updated, locale)} />
        <Metric label={t("common.error")} value={formatNumber(run.failed, locale)} tone={run.failed > 0 ? "warning" : undefined} />
        <Metric label={t("common.warnings")} value={formatNumber(run.warnings, locale)} tone={run.warnings > 0 ? "warning" : undefined} />
        <Metric label={t("common.missing")} value={run.missing === null ? "–" : formatNumber(run.missing, locale)} tone={run.missing ? "warning" : undefined} />
      </dl>
      <Facts
        items={[
          [t("common.started"), run.startedLabel],
          [t("common.finished"), run.finishedLabel ?? "–"],
          [t("common.duration"), run.durationLabel ?? "–"],
        ]}
      />
      {run.errorMessage && <Notice tone="danger">{operationError(run.errorMessage, t)}</Notice>}
    </div>
  );
}

const STATUS_ORDER: { status: MetadataStatus; bar: string }[] = [
  // Soft solid tones; every share is also listed with its label and number below the bar.
  { status: "matched", bar: "bg-detect-person-solid" },
  { status: "archiveOnly", bar: "bg-detect-other-solid" },
  { status: "pendingClip", bar: "bg-detect-face-solid" },
];

function WorkerSection({ background }: { background: BackgroundStatusModel }) {
  const { t } = useI18n();
  const { worker } = background;
  const hint: Partial<Record<typeof worker.kind, { tone: "warning" | "neutral" | "danger" | "info"; text: string }>> = {
    notStarted: {
      tone: "neutral",
      text: t("system.workerNotStarted"),
    },
    stale: {
      tone: "warning",
      text: t("system.workerStale"),
    },
    stopped: { tone: "neutral", text: t("system.workerStopped") },
  };
  const note = worker.kind === "error" && worker.errorMessage ? { tone: "danger" as const, text: operationError(worker.errorMessage, t) } : hint[worker.kind];
  return (
    <SectionCard title={t("system.worker")} description={t("system.workerDescription")} action={<StatusPill badge={{ ...WORKER_BADGES[worker.kind], label: t(WORKER_BADGES[worker.kind].label) }} />}>
      {worker.kind !== "notStarted" && (
        <Facts
          items={[
            [t("system.heartbeat"), worker.heartbeatLabel ?? "–"],
            [t("common.started"), worker.startedLabel ?? "–"],
            ...(worker.stoppedLabel ? ([[t("common.finished"), worker.stoppedLabel]] as [string, string][]) : []),
          ]}
        />
      )}
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
    </SectionCard>
  );
}

function ProtectCard({ background, system }: { background: BackgroundStatusModel; system: SystemStatusModel }) {
  const { t, locale } = useI18n();
  const { protect } = background;
  const facts: [string, string][] = [];
  if (protect.sinceLabel && protect.kind !== "disabled" && protect.kind !== "notConfigured") facts.push([t("system.since"), protect.sinceLabel]);
  if (protect.lastConnectedLabel && protect.kind !== "connected") facts.push([t("system.lastConnected"), protect.lastConnectedLabel]);
  facts.push(
    [t("common.cameras"), t("system.onlineCount", { online: system.camerasOnline, count: system.camerasTotal })],
    [t("system.lastEvent"), system.lastProtectEventLabel ?? t("system.noneYet")],
    [t("system.protectEvents"), formatNumber(system.protectEventsTotal, locale)],
  );
  return (
    <SectionCard title="UniFi Protect" action={<StatusPill badge={{ ...PROTECT_BADGES[protect.kind], label: t(PROTECT_BADGES[protect.kind].label) }} />}>
      <Facts items={facts} />
      {protect.kind === "notConfigured" && <Notice tone="neutral">{t("system.notConfigured")}</Notice>}
      {protect.kind === "disabled" && <Notice tone="neutral">{t("system.disabled")}</Notice>}
      {protect.kind === "unknown" && <Notice tone="warning">{t("system.unknown")}</Notice>}
      {protect.errorMessage && (
        <Notice tone={protect.kind === "reconnecting" ? "warning" : "danger"}>
          {operationError(protect.errorMessage, t)}
          {protect.lastErrorLabel && <span className="mt-1 block text-xs opacity-80">{protect.lastErrorLabel}</span>}
        </Notice>
      )}
    </SectionCard>
  );
}

function NasCard({ background, system }: { background: BackgroundStatusModel; system: SystemStatusModel }) {
  const { t, locale } = useI18n();
  const { scan } = background;
  const badge: StatusBadge =
    scan.kind === "noStatus"
      ? system.lastScan
        ? { ...SCAN_RUN_BADGES[system.lastScan.status], label: t(SCAN_RUN_BADGES[system.lastScan.status].label) }
        : { label: t("system.noScan"), tone: "neutral", icon: HardDrive }
      : { ...JOB_BADGES[scan.kind], label: t(JOB_BADGES[scan.kind].label) };
  const lastSuccess = system.lastScan?.status === "completed" ? system.lastScan : system.lastCompletedScan;
  return (
    <SectionCard title={t("system.scan")} action={<StatusPill badge={badge} />}>
      <Facts
        items={[
          [t("system.lastScan"), system.lastScan?.relativeLabel ?? "–"],
          [t("system.lastSuccess"), lastSuccess?.relativeLabel ?? "–"],
          [t("common.duration"), system.lastScan?.durationLabel ?? "–"],
          [t("system.nextScan"), scan.nextRunLabel ?? "–"],
          [t("system.clips"), formatNumber(system.clipsTotal, locale)],
          [t("system.size"), formatBytes(system.archiveSizeBytes, locale)],
        ]}
      />
      {scan.errorMessage && <Notice tone="danger">{operationError(scan.errorMessage, t)}</Notice>}
    </SectionCard>
  );
}

function ReconciliationCard({ background }: { background: BackgroundStatusModel }) {
  const { t, locale } = useI18n();
  const { reconciliation: r } = background;
  const badge: StatusBadge = r.kind === "noStatus" ? { label: t("status.noStatus"), tone: "neutral", icon: HardDrive } : { ...JOB_BADGES[r.kind], label: t(JOB_BADGES[r.kind].label) };
  const count = (value: number | null) => (value === null ? "–" : formatNumber(value, locale));
  return (
    <SectionCard title={t("system.reconciliation")} action={<StatusPill badge={badge} />}>
      <Facts
        items={[
          [t("system.lastRun"), r.lastStartedLabel ?? "–"],
          [t("system.lastSuccess"), r.lastSucceededLabel ?? "–"],
          [t("common.duration"), r.durationLabel ?? "–"],
          [t("system.nextRun"), r.nextRunLabel ?? "–"],
        ]}
      />
      {r.lastSucceededLabel && (
        <dl className="grid grid-cols-2 gap-2.5">
          <Metric label={t("common.new")} value={count(r.eventsCreated)} />
          <Metric label={t("system.merged")} value={count(r.eventsMerged)} />
          <Metric label={t("system.split")} value={count(r.eventsSplit)} />
          <Metric label={t("system.temporal")} value={count(r.temporalFallbackEvents)} />
        </dl>
      )}
      {r.errorMessage && <Notice tone="danger">{operationError(r.errorMessage, t)}</Notice>}
    </SectionCard>
  );
}

export function SystemView({ system, background }: { system: SystemStatusModel; background: BackgroundStatusModel }) {
  const { t, locale } = useI18n();
  return (
    <>
      <PageHeader
        title={t("common.system")}
        description={t("system.description")}
        actions={<StatusRefresh intervalMs={REFRESH_INTERVAL_MS} checkedAtLabel={background.checkedAtLabel} />}
      />

      <div className="flex flex-col gap-6">
        <WorkerSection background={background} />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ProtectCard background={background} system={system} />
          <NasCard background={background} system={system} />
          <ReconciliationCard background={background} />
          <SectionCard title={t("system.database")} action={<StatusPill badge={{ label: t("status.reachable"), tone: "success", icon: Database }} />}>
            <Facts
              items={[
                ["PostgreSQL", system.databaseVersion],
                [t("system.timeZone"), system.timeZone],
              ]}
            />
          </SectionCard>
        </div>

        <SectionCard title={t("system.archiveEvents")} description={t("system.archiveDescription")}>
          {system.eventsTotal === 0 ? (
            <p className="text-sm text-muted-foreground">{t("system.noEvents")}</p>
          ) : (
            <>
              <div aria-hidden className="flex h-3 overflow-hidden rounded-full bg-surface-muted">
                {STATUS_ORDER.map(({ status, bar }) => (
                  <div key={status} className={bar} style={{ width: `${(system.eventsByStatus[status] / system.eventsTotal) * 100}%` }} />
                ))}
              </div>
              <dl className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <Metric label={t("common.events")} value={formatNumber(system.eventsTotal, locale)} />
                {STATUS_ORDER.map(({ status, bar }) => (
                  <Metric key={status} label={t(METADATA_STATUS_KEYS[status])} value={formatNumber(system.eventsByStatus[status], locale)} dot={bar} />
                ))}
              </dl>
            </>
          )}
        </SectionCard>

        <SectionCard title={t("system.lastNasScan")} description={system.lastScan ? undefined : t("system.startScan")}>
          {system.lastScan ? <ScanRun run={system.lastScan} /> : <p className="text-sm text-muted-foreground">{t("system.noRuns")}</p>}
          {system.lastCompletedScan && (
            <div className="flex flex-col gap-3 border-t pt-5">
              <h3 className="text-sm font-semibold">{t("system.lastSuccessfulScan")}</h3>
              <ScanRun run={system.lastCompletedScan} />
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
