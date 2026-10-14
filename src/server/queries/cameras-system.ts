import "server-only";

import { sql } from "drizzle-orm";

import type { MetadataStatus } from "@/domain/types";
import { formatRelative } from "@/lib/format";
import { addDays, dayKeyInZone, startOfDayInZone } from "@/lib/time-zone";
import type { CameraViewModel, SystemStatusModel } from "@/lib/view-models";
import { sortCameras, toCameraViewModel, toScanRunModel, type ScanRunRow } from "@/server/view-models/cameras-system";
import { sanitizeStatusMessage } from "@/server/worker/sanitize";

import { toDate, toDateOrNull, type QueryContext } from "./context";

type Timestamp = string | Date;

/** All cameras with small clip statistics (one grouped query, no query per camera). */
export async function getCameras(context: QueryContext): Promise<CameraViewModel[]> {
  const { db, now, timeZone, format } = context;
  const today = dayKeyInZone(now, timeZone);
  const result = await db.execute<{
    id: string;
    name: string;
    state: "online" | "offline";
    protect_state: string | null;
    protect_device_id: string;
    mac: string | null;
    smart_detect_types: string[];
    last_seen_at: Timestamp | null;
    clip_count: number | null;
    clips_today: number | null;
    storage_bytes: string | number | null;
    last_clip_at: Timestamp | null;
  }>(sql`
    select cam.id, cam.name, cam.state, cam.protect_state, cam.protect_device_id, cam.mac,
           cam.smart_detect_types, cam.last_seen_at,
           s.clip_count, s.clips_today, s.storage_bytes, s.last_clip_at
    from cameras cam
    left join (
      select camera_id, count(*)::int as clip_count,
             (count(*) filter (where start_at >= ${startOfDayInZone(today, timeZone).toISOString()}::timestamptz
                                 and start_at < ${startOfDayInZone(addDays(today, 1), timeZone).toISOString()}::timestamptz))::int as clips_today,
             coalesce(sum(file_size_bytes), 0) as storage_bytes, max(start_at) as last_clip_at
      from archived_clips where camera_id is not null group by camera_id
    ) s on s.camera_id = cam.id`);
  return sortCameras(
    result.rows.map((row) =>
      toCameraViewModel(
        {
          id: row.id,
          name: row.name,
          state: row.state,
          protectState: row.protect_state,
          protectDeviceId: row.protect_device_id,
          mac: row.mac,
          smartDetectTypes: row.smart_detect_types,
          lastSeenAt: toDateOrNull(row.last_seen_at),
          clipCount: row.clip_count ?? 0,
          clipsToday: row.clips_today ?? 0,
          storageBytes: Number(row.storage_bytes ?? 0),
          lastClipAt: toDateOrNull(row.last_clip_at),
        },
        format,
        now,
      ),
    ),
  );
}

type ScanRunDbRow = {
  status: ScanRunRow["status"];
  started_at: Timestamp;
  finished_at: Timestamp | null;
  discovered_count: number;
  updated_count: number;
  unchanged_count: number;
  failed_count: number;
  warning_count: number;
  missing_count: number | null;
  error_message: string | null;
};

const toScanRunRow = (row: ScanRunDbRow): ScanRunRow => ({
  status: row.status,
  startedAt: toDate(row.started_at),
  finishedAt: toDateOrNull(row.finished_at),
  discoveredCount: row.discovered_count,
  updatedCount: row.updated_count,
  unchangedCount: row.unchanged_count,
  failedCount: row.failed_count,
  warningCount: row.warning_count,
  missingCount: row.missing_count,
  // Scan errors may name the archive path; the browser never sees internal paths.
  errorMessage: row.error_message ? sanitizeStatusMessage(row.error_message, { archiveRoot: process.env.ARCHIVE_ROOT }) : null,
});

/**
 * Only facts the database can tell: scan runs, counts, the newest Protect message. The live
 * state of the background worker comes from getBackgroundStatus() (background-status.ts).
 */
export async function getSystemStatus(context: QueryContext): Promise<SystemStatusModel> {
  const { db, now, format, timeZone } = context;
  const scanColumns = sql`status, started_at, finished_at, discovered_count, updated_count, unchanged_count,
    failed_count, warning_count, missing_count, error_message`;
  const lastScan = await db.execute<ScanRunDbRow>(sql`select ${scanColumns} from archive_scan_runs order by started_at desc limit 1`);
  const lastCompleted = await db.execute<ScanRunDbRow>(
    sql`select ${scanColumns} from archive_scan_runs where status = 'completed' order by started_at desc limit 1`,
  );
  const counts = await db.execute<{
    version: string;
    clips_total: number;
    archive_size: string | number;
    events_total: number;
    matched: number;
    archive_only: number;
    pending_clip: number;
    cameras_total: number;
    cameras_online: number;
    protect_events_total: number;
    last_protect_received: Timestamp | null;
  }>(sql`
    select current_setting('server_version') as version,
      (select count(*)::int from archived_clips) as clips_total,
      (select coalesce(sum(file_size_bytes), 0) from archived_clips) as archive_size,
      (select count(*)::int from archive_events) as events_total,
      (select count(*)::int from archive_events where metadata_status = 'matched') as matched,
      (select count(*)::int from archive_events where metadata_status = 'archiveOnly') as archive_only,
      (select count(*)::int from archive_events where metadata_status = 'pendingClip') as pending_clip,
      (select count(*)::int from cameras) as cameras_total,
      (select count(*)::int from cameras where state = 'online') as cameras_online,
      (select count(*)::int from protect_events) as protect_events_total,
      (select max(last_received_at) from protect_events) as last_protect_received`);
  const c = counts.rows[0];
  const lastProtect = toDateOrNull(c.last_protect_received);
  const last = lastScan.rows[0] ? toScanRunModel(toScanRunRow(lastScan.rows[0]), format, now) : null;
  const completed = lastCompleted.rows[0] ? toScanRunModel(toScanRunRow(lastCompleted.rows[0]), format, now) : null;
  const eventsByStatus: Record<MetadataStatus, number> = {
    matched: c.matched,
    archiveOnly: c.archive_only,
    pendingClip: c.pending_clip,
  };
  return {
    databaseVersion: c.version.split(" ")[0],
    lastScan: last,
    lastCompletedScan: last?.status === "completed" ? null : completed,
    clipsTotal: c.clips_total,
    archiveSizeBytes: Number(c.archive_size),
    eventsTotal: c.events_total,
    eventsByStatus,
    camerasTotal: c.cameras_total,
    camerasOnline: c.cameras_online,
    protectEventsTotal: c.protect_events_total,
    lastProtectEventLabel: lastProtect ? formatRelative(lastProtect, now, format.locale) : null,
    lastProtectEventDateTime: lastProtect ? format.dateTime(lastProtect) : null,
    timeZone,
  };
}
