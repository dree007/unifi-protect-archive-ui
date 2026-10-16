import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { MetadataStatus } from "@/domain/types";
import { detectionTypesForQuery, type ArchiveFilters } from "@/lib/archive-filters";
import { PENDING_CLIP_GRACE_MS } from "@/lib/pending-clip";
import { addDays, dayKeyInZone, startOfDayInZone } from "@/lib/time-zone";
import type { ArchivePageModel, EventCardModel, EventDetailModel, FilterOption } from "@/lib/view-models";
import { uuidArray } from "@/server/db/sql";
import {
  toEventCardModel,
  toEventDetailModel,
  type EventClipRow,
  type EventProtectRow,
  type EventRow,
} from "@/server/view-models/archive-events";

import { toDate, toDateOrNull, type QueryContext } from "./context";

/**
 * Archive queries: keyset-paginated event list with server-side filters, and event details.
 * Lists load only what the cards show; details load clips and Protect events of one event.
 */

export const ARCHIVE_PAGE_SIZE = 30;

// --- cursor ----------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `timestamptz` as PostgreSQL prints it, e.g. `2026-03-29 13:01:04.123+02`. */
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

interface Cursor {
  /** `start_at` exactly as PostgreSQL printed it (no precision loss). */
  startAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.startAt, cursor.id])).toString("base64url");
}

/** `undefined` for anything that is not a cursor we issued. */
export function decodeCursor(raw: string | null | undefined): Cursor | undefined {
  if (!raw || raw.length > 200) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [startAt, id] = value;
    if (typeof startAt !== "string" || typeof id !== "string" || !UUID.test(id)) return undefined;
    if (!PG_TIMESTAMPTZ.test(startAt)) return undefined;
    return { startAt, id };
  } catch {
    return undefined;
  }
}

// --- filters ----------------------------------------------------------------------------------

/**
 * Time range of a period in the app time zone: [start, end), start inclusive, end exclusive.
 * Day boundaries are local midnights in APP_TIME_ZONE (DST days have 23 or 25 hours).
 * - today: today 00:00 → tomorrow 00:00
 * - 7d / 30d: today and the previous 6 / 29 calendar days (no end: nothing lies in the future)
 * - custom: `from` 00:00 → the day after `to` 00:00; a missing bound is open. If `from` is after
 *   `to` the range is empty (never swapped silently; the UI explains it).
 */
export function periodRange(filters: ArchiveFilters, now: Date, timeZone: string): { start?: Date; end?: Date } {
  const today = dayKeyInZone(now, timeZone);
  switch (filters.period) {
    case "all":
      return {};
    case "today":
      return { start: startOfDayInZone(today, timeZone), end: startOfDayInZone(addDays(today, 1), timeZone) };
    case "7d":
      return { start: startOfDayInZone(addDays(today, -6), timeZone) };
    case "30d":
      return { start: startOfDayInZone(addDays(today, -29), timeZone) };
    case "custom":
      return {
        start: filters.from ? startOfDayInZone(filters.from, timeZone) : undefined,
        end: filters.to ? startOfDayInZone(addDays(filters.to, 1), timeZone) : undefined,
      };
  }
}

/** `%term%` for ILIKE, with LIKE wildcards in the term escaped. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const hasProtectEvent = (condition: SQL) => sql`exists (
  select 1 from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
  where l.archive_event_id = e.id and ${condition})`;

const hasClip = (condition: SQL) => sql`exists (
  select 1 from archive_event_clips l join archived_clips c on c.id = l.archived_clip_id
  where l.archive_event_id = e.id and ${condition})`;

function filterConditions(filters: ArchiveFilters, context: Pick<QueryContext, "now" | "timeZone">): SQL[] {
  const conditions: SQL[] = [];
  const { start, end } = periodRange(filters, context.now, context.timeZone);
  if (start) conditions.push(sql`e.start_at >= ${start.toISOString()}::timestamptz`);
  if (end) conditions.push(sql`e.start_at < ${end.toISOString()}::timestamptz`);

  if (filters.cameraId !== "all") {
    const camera = sql`${filters.cameraId}::uuid`;
    conditions.push(sql`(${hasClip(sql`c.camera_id = ${camera}`)} or ${hasProtectEvent(sql`p.camera_id = ${camera}`)})`);
  }

  // "With detection" = at least one linked Protect event with at least one detection type.
  const detected = hasProtectEvent(sql`cardinality(p.smart_detect_types) > 0`);
  if (filters.detection === "none") conditions.push(sql`not ${detected}`);
  else if (filters.detection !== "all") {
    conditions.push(hasProtectEvent(sql`p.smart_detect_types @> array[${filters.detection}]::text[]`));
  }
  if (filters.onlyDetected) conditions.push(detected);

  if (filters.query) {
    // Pragmatic substring search (no full-text index), case-insensitive, LIKE wildcards in the
    // text escaped: camera names (from the file and the current Protect name), clip file names,
    // Protect event IDs – in ANY clip / Protect event of the event, so multi-camera events are
    // found via each camera. A text that names a detection type („Person“, „Fahrzeug“) also
    // matches events with that detection. Combined (AND) with the other filters.
    const pattern = containsPattern(filters.query);
    const detectionTypes = detectionTypesForQuery(filters.query);
    const byDetection =
      detectionTypes.length > 0
        ? sql` or ${hasProtectEvent(sql`p.smart_detect_types && array[${sql.join(detectionTypes.map((type) => sql`${type}`), sql`, `)}]::text[]`)}`
        : sql``;
    conditions.push(sql`(
      ${hasClip(sql`(c.camera_name ilike ${pattern} or c.file_name ilike ${pattern}
        or exists (select 1 from cameras cam where cam.id = c.camera_id and cam.name ilike ${pattern}))`)}
      or ${hasProtectEvent(sql`(p.protect_event_id ilike ${pattern}
        or exists (select 1 from cameras cam where cam.id = p.camera_id and cam.name ilike ${pattern}))`)}${byDetection}
    )`);
  }
  return conditions;
}

/**
 * Events shown in lists and counters (`e` = archive_events): everything except `pendingClip`
 * events whose grace period is over – the SQL form of `pendingClipHiddenAt` (src/lib/pending-clip.ts).
 */
export function shownInOverview(now: Date): SQL {
  const cutoff = new Date(now.getTime() - PENDING_CLIP_GRACE_MS).toISOString();
  return sql`(e.metadata_status <> 'pendingClip' or coalesce(e.end_at, e.start_at) > ${cutoff}::timestamptz)`;
}

const where = (conditions: SQL[]) => (conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``);

// --- rows -------------------------------------------------------------------------------------

type Timestamp = string | Date;

async function loadEventLinks(
  eventIds: readonly string[],
  db: QueryContext["db"],
): Promise<{ clips: EventClipRow[]; protectEvents: EventProtectRow[] }> {
  if (eventIds.length === 0) return { clips: [], protectEvents: [] };
  const ids = uuidArray(eventIds);
  const clips = await db.execute<{
    event_id: string;
    primary_group_id: string;
    clip_id: string;
    camera_id: string | null;
    camera_name: string;
    file_path: string;
    file_size_bytes: string | number | null;
    file_modified_at: Timestamp | null;
    start_at: Timestamp;
    end_at: Timestamp;
    duration_ms: number;
  }>(sql`
    select l.archive_event_id as event_id, l.primary_group_id, c.id as clip_id, c.camera_id,
           coalesce(cam.name, c.camera_name) as camera_name, c.file_path, c.file_size_bytes,
           c.file_modified_at, c.start_at, c.end_at, c.duration_ms
    from archive_event_clips l
    join archived_clips c on c.id = l.archived_clip_id
    left join cameras cam on cam.id = c.camera_id
    where l.archive_event_id = any(${ids})`);
  const protectEvents = await db.execute<{
    event_id: string;
    primary_group_id: string;
    protect_event_id: string;
    event_type: string;
    camera_id: string | null;
    camera_name: string | null;
    smart_detect_types: string[];
    start_at: Timestamp;
    end_at: Timestamp | null;
  }>(sql`
    select l.archive_event_id as event_id, l.primary_group_id, p.protect_event_id, p.event_type, p.camera_id,
           cam.name as camera_name, p.smart_detect_types, p.start_at, p.end_at
    from archive_event_protect_events l
    join protect_events p on p.id = l.protect_event_id
    left join cameras cam on cam.id = p.camera_id
    where l.archive_event_id = any(${ids})`);
  return {
    clips: clips.rows.map((row) => ({
      eventId: row.event_id,
      primaryGroupId: row.primary_group_id,
      clipId: row.clip_id,
      cameraId: row.camera_id,
      cameraName: row.camera_name,
      filePath: row.file_path,
      fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
      fileModifiedAt: toDateOrNull(row.file_modified_at),
      startAt: toDate(row.start_at),
      endAt: toDate(row.end_at),
      durationMs: Number(row.duration_ms),
    })),
    protectEvents: protectEvents.rows.map((row) => ({
      eventId: row.event_id,
      primaryGroupId: row.primary_group_id,
      protectEventId: row.protect_event_id,
      eventType: row.event_type,
      cameraId: row.camera_id,
      cameraName: row.camera_name,
      smartDetectTypes: row.smart_detect_types,
      startAt: toDate(row.start_at),
      endAt: toDateOrNull(row.end_at),
    })),
  };
}

function groupBy<T extends { eventId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.eventId);
    if (list) list.push(row);
    else map.set(row.eventId, [row]);
  }
  return map;
}

/** Card models for the given events (in the given order); one batch query each for clips and Protect events. */
export async function toCards(events: readonly EventRow[], context: QueryContext): Promise<EventCardModel[]> {
  const { clips, protectEvents } = await loadEventLinks(
    events.map((event) => event.id),
    context.db,
  );
  const clipsByEvent = groupBy(clips);
  const protectByEvent = groupBy(protectEvents);
  return events.map((event) =>
    toEventCardModel(event, clipsByEvent.get(event.id) ?? [], protectByEvent.get(event.id) ?? [], context),
  );
}

// --- public queries ------------------------------------------------------------------------------

/**
 * One page of archive events, newest first (start DESC, id DESC as tie-breaker), filtered in
 * PostgreSQL. Keyset pagination: `cursor` is the last row of the previous page. Pending events
 * past their grace period are left out (see {@link shownInOverview}).
 */
export async function getArchivePage(
  filters: ArchiveFilters,
  cursor: string | null | undefined,
  context: QueryContext,
  pageSize = ARCHIVE_PAGE_SIZE,
): Promise<ArchivePageModel> {
  const conditions = [...filterConditions(filters, context), shownInOverview(context.now)];
  const after = decodeCursor(cursor);
  if (after) conditions.push(sql`(e.start_at, e.id) < (${after.startAt}::timestamptz, ${after.id}::uuid)`);

  const result = await context.db.execute<{
    id: string;
    start_at: Timestamp;
    start_text: string;
    end_at: Timestamp | null;
    metadata_status: MetadataStatus;
  }>(sql`
    select e.id, e.start_at, e.start_at::text as start_text, e.end_at, e.metadata_status
    from archive_events e
    ${where(conditions)}
    order by e.start_at desc, e.id desc
    limit ${pageSize + 1}`);

  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  const events = await toCards(
    rows.map((row) => ({ id: row.id, startAt: toDate(row.start_at), endAt: toDateOrNull(row.end_at), status: row.metadata_status })),
    context,
  );
  return {
    events,
    nextCursor: result.rows.length > pageSize && last ? encodeCursor({ startAt: last.start_text, id: last.id }) : null,
  };
}

/** Whether there is any archive event at all (fresh installation otherwise). */
export async function hasArchiveEvents(context: QueryContext): Promise<boolean> {
  const result = await context.db.execute<{ found: boolean }>(sql`select exists (select 1 from archive_events) as found`);
  return result.rows[0].found;
}

export async function getEventDetail(eventId: string, context: QueryContext): Promise<EventDetailModel | undefined> {
  if (!UUID.test(eventId)) return undefined;
  const result = await context.db.execute<{
    id: string;
    start_at: Timestamp;
    end_at: Timestamp | null;
    metadata_status: MetadataStatus;
  }>(sql`select id, start_at, end_at, metadata_status from archive_events where id = ${eventId}::uuid`);
  const row = result.rows[0];
  if (!row) return undefined;
  const { clips, protectEvents } = await loadEventLinks([row.id], context.db);
  return toEventDetailModel(
    { id: row.id, startAt: toDate(row.start_at), endAt: toDateOrNull(row.end_at), status: row.metadata_status },
    clips,
    protectEvents,
    context,
  );
}

/** Camera filter options: all known cameras, by name. */
export async function getCameraFilterOptions(context: QueryContext): Promise<FilterOption[]> {
  const result = await context.db.execute<{ id: string; name: string }>(sql`select id, name from cameras order by name, id`);
  return result.rows.map((row) => ({ value: row.id, label: row.name }));
}

/** Detection types that actually occur (known and unknown ones), most frequent first. */
export async function getDetectionTypeOptions(context: QueryContext): Promise<string[]> {
  const result = await context.db.execute<{ type: string }>(sql`
    select t as type from protect_events p cross join unnest(p.smart_detect_types) as t
    group by t order by count(*) desc, t`);
  return result.rows.map((row) => row.type);
}
