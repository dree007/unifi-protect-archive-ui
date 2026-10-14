import type { DateFormat } from "@/lib/date-format";
import { formatDuration, formatRelative } from "@/lib/format";
import type { CameraViewModel, ScanRunModel } from "@/lib/view-models";

/** Pure mapping of camera and scan run rows to view models. */

export interface CameraRow {
  id: string;
  name: string;
  state: "online" | "offline";
  protectState: string | null;
  protectDeviceId: string;
  mac: string | null;
  smartDetectTypes: string[];
  lastSeenAt: Date | null;
  clipCount: number;
  clipsToday: number;
  storageBytes: number;
  lastClipAt: Date | null;
}

/** `CONNECTED` → "Connected", `FIRMWARE_UPDATING` → "Firmware updating". Unknown values are fine. */
export function humanizeProtectState(state: string | null): string | null {
  if (!state) return null;
  const words = state.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

export function toCameraViewModel(row: CameraRow, format: DateFormat, now: Date): CameraViewModel {
  return {
    id: row.id,
    name: row.name,
    online: row.state === "online",
    protectStateLabel: humanizeProtectState(row.protectState),
    protectDeviceId: row.protectDeviceId,
    mac: row.mac,
    smartDetectTypes: row.smartDetectTypes,
    lastSeenLabel: row.lastSeenAt ? `${formatRelative(row.lastSeenAt, now, format.locale)} (${format.dateTime(row.lastSeenAt)})` : null,
    clipCount: row.clipCount,
    clipsToday: row.clipsToday,
    storageBytes: row.storageBytes,
    lastClipLabel: row.lastClipAt ? formatRelative(row.lastClipAt, now, format.locale) : null,
  };
}

/** Online first, then by name. */
export function sortCameras<T extends { online: boolean; name: string }>(cameras: T[]): T[] {
  return [...cameras].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "de"));
}

export interface ScanRunRow {
  status: "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  discoveredCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  warningCount: number;
  missingCount: number | null;
  errorMessage: string | null;
}

export function toScanRunModel(row: ScanRunRow, format: DateFormat, now: Date): ScanRunModel {
  return {
    status: row.status,
    startedLabel: format.dateTime(row.startedAt),
    finishedLabel: row.finishedAt ? format.dateTime(row.finishedAt) : null,
    durationLabel: row.finishedAt ? formatDuration((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000, format.locale) : null,
    relativeLabel: formatRelative(row.finishedAt ?? row.startedAt, now, format.locale),
    filesFound: row.discoveredCount + row.updatedCount + row.unchangedCount + row.failedCount,
    discovered: row.discoveredCount,
    updated: row.updatedCount,
    unchanged: row.unchangedCount,
    failed: row.failedCount,
    warnings: row.warningCount,
    missing: row.missingCount,
    errorMessage: row.errorMessage,
  };
}
