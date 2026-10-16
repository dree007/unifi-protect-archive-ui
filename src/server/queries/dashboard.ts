import "server-only";

import { sql } from "drizzle-orm";

import type { MetadataStatus } from "@/domain/types";
import { DEFAULT_ARCHIVE_FILTERS } from "@/lib/archive-filters";
import { formatRelative } from "@/lib/format";
import { addDays, dayKeyInZone, startOfDayInZone } from "@/lib/time-zone";
import type { DashboardModel } from "@/lib/view-models";

import { getArchivePage, shownInOverview, toCards } from "./archive";
import { toDate, toDateOrNull, type QueryContext } from "./context";

const RECENT_EVENTS = 5;
const DETECTION_DAYS = 7;

export async function getDashboard(context: QueryContext): Promise<DashboardModel> {
  const { db, now, timeZone, format } = context;
  // Event figures follow the event list: pending events past their grace period are left out.
  const shown = shownInOverview(now);
  const today = dayKeyInZone(now, timeZone);
  const todayStart = startOfDayInZone(today, timeZone);
  const tomorrowStart = startOfDayInZone(addDays(today, 1), timeZone);
  const detectionsSince = startOfDayInZone(addDays(today, -(DETECTION_DAYS - 1)), timeZone);

  const totals = await db.execute<{
    events_today: number;
    clips_total: number;
    archive_size: string | number;
    cameras_total: number;
    cameras_online: number;
    events_total: number;
    protect_events_total: number;
  }>(sql`
    select
      (select count(*)::int from archive_events e
        where e.start_at >= ${todayStart.toISOString()}::timestamptz and e.start_at < ${tomorrowStart.toISOString()}::timestamptz
          and ${shown}) as events_today,
      (select count(*)::int from archived_clips) as clips_total,
      (select coalesce(sum(file_size_bytes), 0) from archived_clips) as archive_size,
      (select count(*)::int from cameras) as cameras_total,
      (select count(*)::int from cameras where state = 'online') as cameras_online,
      (select count(*)::int from archive_events) as events_total,
      (select count(*)::int from protect_events) as protect_events_total`);
  const t = totals.rows[0];

  // Newest archive event with at least one detection type.
  const latest = await db.execute<{ id: string; start_at: string | Date; end_at: string | Date | null; metadata_status: MetadataStatus }>(sql`
    select e.id, e.start_at, e.end_at, e.metadata_status from archive_events e
    where exists (
      select 1 from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
      where l.archive_event_id = e.id and cardinality(p.smart_detect_types) > 0)
      and ${shown}
    order by e.start_at desc, e.id desc limit 1`);
  let latestDetection: DashboardModel["latestDetection"] = null;
  if (latest.rows[0]) {
    const row = latest.rows[0];
    const startAt = toDate(row.start_at);
    const [card] = await toCards([{ id: row.id, startAt, endAt: toDateOrNull(row.end_at), status: row.metadata_status }], context);
    latestDetection = {
      eventId: row.id,
      detectionTypes: card.detectionTypes,
      cameras: card.cameras,
      relativeLabel: formatRelative(startAt, now, format.locale),
      timeLabel: format.eventTime(startAt, now),
    };
  }

  const scan = await db.execute<{ status: string; finished_at: string | Date | null }>(sql`
    select status, finished_at from archive_scan_runs order by started_at desc limit 1`);
  const lastCompleted = await db.execute<{ finished_at: string | Date }>(sql`
    select finished_at from archive_scan_runs where status = 'completed' order by started_at desc limit 1`);
  const lastScanAt = toDateOrNull(lastCompleted.rows[0]?.finished_at ?? null);

  const detections = await db.execute<{ type: string; count: number }>(sql`
    select t as type, count(distinct e.id)::int as count
    from archive_events e
    join archive_event_protect_events l on l.archive_event_id = e.id
    join protect_events p on p.id = l.protect_event_id
    cross join unnest(p.smart_detect_types) as t
    where e.start_at >= ${detectionsSince.toISOString()}::timestamptz and ${shown}
    group by t order by count desc, t`);

  const recent = await getArchivePage(DEFAULT_ARCHIVE_FILTERS, null, context, RECENT_EVENTS);

  return {
    isEmpty: t.events_total === 0 && t.clips_total === 0 && t.protect_events_total === 0,
    eventsToday: t.events_today,
    clipsTotal: t.clips_total,
    archiveSizeBytes: Number(t.archive_size),
    camerasTotal: t.cameras_total,
    camerasOnline: t.cameras_online,
    latestDetection,
    lastScanLabel: lastScanAt ? formatRelative(lastScanAt, now, format.locale) : null,
    lastScanFailed: scan.rows[0]?.status === "failed",
    recentEvents: recent.events,
    detections: detections.rows,
  };
}
