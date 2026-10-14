import type { BackgroundComponent, ProtectDetails, ReconciliationDetails } from "@/domain/background";
import type { DateFormat } from "@/lib/date-format";
import { formatDuration, formatRelative } from "@/lib/format";
import type {
  BackgroundStatusModel,
  JobStatusKind,
  JobStatusModel,
  ProtectStatusKind,
  ProtectStatusModel,
  ReconciliationStatusModel,
  WorkerStatusModel,
} from "@/lib/view-models";
import { sanitizeStatusMessage } from "@/server/worker/sanitize";

/**
 * Pure derivation of the system page's operating state (docs/background-worker.md). The rules
 * that matter:
 *
 * - no worker row: never started – never "all good",
 * - `starting`/`running`/`stopping` count only with a heartbeat younger than the stale threshold;
 *   otherwise the worker is `stale` and no component state is trusted,
 * - Protect is `connected` only if the worker is live and its stored state says so (never
 *   guessed from the last received event); `disabled` is a configuration fact and shown as such.
 */

export interface StatusRow {
  component: BackgroundComponent;
  instanceId: string;
  state: string;
  heartbeatAt: Date | null;
  /** Age of the heartbeat by the database clock (no clock skew between containers). */
  heartbeatAgeMs: number | null;
  instanceStartedAt: Date | null;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastErrorMessage: string | null;
  nextRunAt: Date | null;
  details: Record<string, unknown> | null;
  updatedAt: Date;
}

export interface DeriveOptions {
  staleMs: number;
  now: Date;
  format: DateFormat;
  archiveRoot?: string | null;
}

const LIVE_STATES = new Set(["starting", "running", "stopping"]);

export function deriveBackgroundStatus(rows: StatusRow[], options: DeriveOptions): BackgroundStatusModel {
  const byComponent = new Map(rows.map((row) => [row.component, row]));
  const worker = deriveWorker(byComponent.get("worker"), options);
  // Component rows of another (older) instance are not current either.
  const current = (row: StatusRow | undefined) =>
    row && worker.live && row.instanceId === byComponent.get("worker")?.instanceId ? row : undefined;
  return {
    worker,
    protect: deriveProtect(byComponent.get("protect"), current(byComponent.get("protect")), worker, options),
    scan: deriveJob(byComponent.get("archiveScan"), current(byComponent.get("archiveScan")), options),
    reconciliation: deriveReconciliation(byComponent.get("reconciliation"), current(byComponent.get("reconciliation")), options),
    checkedAtLabel: options.format.time(options.now),
  };
}

/** "vor 3 Minuten (14:02)" within a day, otherwise "vor 2 Tagen (07.10.2026, 14:02)". */
function label(date: Date | null, { now, format }: DeriveOptions): string | null {
  if (!date) return null;
  const sameDay = Math.abs(now.getTime() - date.getTime()) < 86_400_000;
  return `${formatRelative(date, now, format.locale)} (${sameDay ? format.time(date) : format.dateTime(date)})`;
}

function message(row: StatusRow, options: DeriveOptions): string | null {
  return row.lastErrorMessage ? sanitizeStatusMessage(row.lastErrorMessage, { archiveRoot: options.archiveRoot }) : null;
}

export function deriveWorker(row: StatusRow | undefined, options: DeriveOptions): WorkerStatusModel {
  if (!row) {
    return { kind: "notStarted", live: false, heartbeatLabel: null, startedLabel: null, stoppedLabel: null, errorMessage: null };
  }
  const fresh = row.heartbeatAgeMs !== null && row.heartbeatAgeMs <= options.staleMs;
  const state = row.state as WorkerStatusModel["kind"];
  const kind: WorkerStatusModel["kind"] = LIVE_STATES.has(row.state) ? (fresh ? state : "stale") : state;
  return {
    kind,
    live: LIVE_STATES.has(row.state) && fresh,
    // Age by the database clock, shown relative to the page's clock.
    heartbeatLabel:
      row.heartbeatAt && row.heartbeatAgeMs !== null
        ? `${formatRelative(new Date(options.now.getTime() - row.heartbeatAgeMs), options.now, options.format.locale)} (${options.format.timeWithSeconds(row.heartbeatAt)})`
        : null,
    startedLabel: label(row.instanceStartedAt, options),
    stoppedLabel: kind === "stopped" || kind === "error" ? label(row.updatedAt, options) : null,
    errorMessage: kind === "error" ? message(row, options) : null,
  };
}

function deriveProtect(
  row: StatusRow | undefined,
  current: StatusRow | undefined,
  worker: WorkerStatusModel,
  options: DeriveOptions,
): ProtectStatusModel {
  const details = (row?.details ?? {}) as ProtectDetails;
  let kind: ProtectStatusKind;
  if (!row || worker.kind === "notStarted") kind = "noStatus";
  else if (row.state === "disabled") kind = details.disabledReason === "notConfigured" ? "notConfigured" : "disabled";
  else if (!current) kind = worker.kind === "stopped" && row.state === "stopped" ? "stopped" : "unknown";
  else kind = row.state as ProtectStatusKind;
  const showError = kind === "authenticationError" || kind === "error" || kind === "reconnecting";
  return {
    kind,
    sinceLabel: current ? label(current.updatedAt, options) : null,
    lastConnectedLabel: row ? label(row.lastSucceededAt, options) : null,
    cameraCount: typeof details.cameraCount === "number" ? details.cameraCount : null,
    errorMessage: showError && row ? message(row, options) : null,
    lastErrorLabel: showError && row ? label(row.lastFailedAt, options) : null,
  };
}

function jobKind(row: StatusRow | undefined, current: StatusRow | undefined): JobStatusKind {
  if (!row) return "noStatus";
  // A stored `running` of a worker that is not live: the run was interrupted or is unknown.
  if (row.state === "running" && !current) return "unknown";
  return row.state as JobStatusKind;
}

function deriveJob(row: StatusRow | undefined, current: StatusRow | undefined, options: DeriveOptions): JobStatusModel {
  const kind = jobKind(row, current);
  return {
    kind,
    lastStartedLabel: row ? label(row.lastStartedAt, options) : null,
    lastSucceededLabel: row ? label(row.lastSucceededAt, options) : null,
    lastFailedLabel: row ? label(row.lastFailedAt, options) : null,
    // Only a live worker will actually run it.
    nextRunLabel: current?.nextRunAt ? formatNext(current.nextRunAt, options) : null,
    errorMessage: kind === "error" && row ? message(row, options) : null,
  };
}

function formatNext(date: Date, { now, format }: DeriveOptions): string {
  return date.getTime() <= now.getTime() ? (format.locale === "de" ? "jetzt" : "now") : `${formatRelative(date, now, format.locale)} (${format.time(date)})`;
}

function deriveReconciliation(
  row: StatusRow | undefined,
  current: StatusRow | undefined,
  options: DeriveOptions,
): ReconciliationStatusModel {
  const base = deriveJob(row, current, options);
  const details = row?.details as Partial<ReconciliationDetails> | null | undefined;
  const value = (key: keyof ReconciliationDetails) => (typeof details?.[key] === "number" ? (details[key] as number) : null);
  const durationMs = value("durationMs");
  return {
    ...base,
    durationLabel: durationMs === null ? null : formatDuration(durationMs / 1000, options.format.locale),
    eventsCreated: value("archiveEventsCreated"),
    eventsMerged: value("archiveEventsMerged"),
    eventsSplit: value("archiveEventsSplit"),
    temporalFallbackEvents: value("temporalFallbackEvents"),
    multiCameraEvents: value("multiCameraEvents"),
  };
}
