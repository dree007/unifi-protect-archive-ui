import "server-only";

import { sql } from "drizzle-orm";

import { uuidArray } from "@/server/db/sql";
import type { DbExecutor } from "@/server/db/types";
import { resolveCameraName } from "@/server/matching/camera-names";

/**
 * Database side of the reconciliation (docs/event-matching.md). Candidate queries narrow the
 * search in PostgreSQL (camera + time window on indexed columns); the final decision is made by
 * the pure rules in src/server/matching.
 */

// --- camera resolution ---------------------------------------------------------------------

export interface CameraResolutionResult {
  clipsResolved: number;
  protectEventsResolved: number;
  /** Clip camera names without an unambiguous camera (clips stay without camera). */
  unresolvedNames: string[];
}

/**
 * Sets `camera_id` where it is still NULL: clips by their file-name camera name
 * (conservative, see camera-names.ts), Protect events by their device ID. Existing
 * assignments are never changed, so later renames in Protect do not move old clips.
 */
export async function resolveMissingCameras(db: DbExecutor): Promise<CameraResolutionResult> {
  const names = await db.execute<{ camera_name: string }>(
    sql`select distinct camera_name from archived_clips where camera_id is null order by camera_name`,
  );
  const cameras = await db.execute<{ id: string; name: string }>(sql`select id, name from cameras`);
  const resolved: { name: string; cameraId: string }[] = [];
  const unresolvedNames: string[] = [];
  for (const { camera_name: name } of names.rows) {
    const cameraId = resolveCameraName(name, cameras.rows);
    if (cameraId) resolved.push({ name, cameraId });
    else unresolvedNames.push(name);
  }
  let clipsResolved = 0;
  if (resolved.length > 0) {
    // One statement (one pass over the unresolved clips) for all names.
    const updated = await db.execute(sql`
      update archived_clips c set camera_id = r.camera_id, updated_at = now()
      from unnest(${sql.param(resolved.map((r) => r.name))}::text[], ${uuidArray(resolved.map((r) => r.cameraId))})
        as r(camera_name, camera_id)
      where c.camera_id is null and c.camera_name = r.camera_name`);
    clipsResolved = updated.rowCount ?? 0;
  }
  const events = await db.execute(sql`
    update protect_events p set camera_id = c.id, updated_at = now()
    from cameras c
    where p.camera_id is null and c.protect_device_id = p.protect_device_id`);
  return { clipsResolved, protectEventsResolved: events.rowCount ?? 0, unresolvedNames };
}

/**
 * Refreshes planner statistics of the source tables. The candidate queries rely on index
 * range scans; on freshly filled tables (first import, many cameras just resolved) stale
 * statistics can make PostgreSQL choose a scan per Protect event instead. ANALYZE samples at
 * most a few ten thousand rows, so this stays cheap even for large archives.
 */
export async function analyzeSourceTables(db: DbExecutor): Promise<void> {
  await db.execute(sql`analyze archived_clips, protect_events`);
}

// --- candidates ----------------------------------------------------------------------------

export interface ClipCandidate {
  protectEventId: string;
  clipId: string;
  cameraId: string;
  protectStartAt: Date;
  protectEndAt: Date;
  clipStartAt: Date;
  clipEndAt: Date;
}

interface CandidateFilter {
  protectEventId?: string;
  clipId?: string;
}

/**
 * Clip/Protect event pairs of the same camera whose intervals are at most `toleranceMs`
 * apart; only closed Protect events. Both time bounds are an index range on
 * (camera_id, start_at), so each Protect event only looks at clips around its own time.
 */
export async function findClipMatchCandidates(
  toleranceMs: number,
  db: DbExecutor,
  { protectEventId, clipId }: CandidateFilter = {},
): Promise<ClipCandidate[]> {
  // The longest clip bounds how far before a Protect event a matching clip can start. It is
  // queried first and passed as a parameter: as a constant, PostgreSQL uses both time bounds as
  // an index range on (camera_id, start_at); as a joined value it would only filter afterwards.
  const longest = await db.execute<{ ms: number }>(
    sql`select coalesce(max(duration_ms), 0)::int as ms from archived_clips where camera_id is not null`,
  );
  const lookBehindMs = toleranceMs + longest.rows[0].ms;
  const result = await db.execute<{
    protect_event_id: string;
    clip_id: string;
    camera_id: string;
    protect_start_at: string;
    protect_end_at: string;
    clip_start_at: string;
    clip_end_at: string;
  }>(sql`
    select p.id as protect_event_id, c.id as clip_id, c.camera_id,
           p.start_at as protect_start_at, p.end_at as protect_end_at,
           c.start_at as clip_start_at, c.end_at as clip_end_at
    from protect_events p
    join archived_clips c
      on c.camera_id = p.camera_id
     and c.start_at <= p.end_at + make_interval(secs => ${toleranceMs / 1000})
     and c.start_at >= p.start_at - make_interval(secs => ${lookBehindMs / 1000})
     and c.end_at >= p.start_at - make_interval(secs => ${toleranceMs / 1000})
    where p.end_at is not null and p.camera_id is not null
      ${protectEventId ? sql`and p.id = ${protectEventId}::uuid` : sql``}
      ${clipId ? sql`and c.id = ${clipId}::uuid` : sql``}
    order by p.start_at, p.id, c.start_at, c.id`);
  return result.rows.map((row) => ({
    protectEventId: row.protect_event_id,
    clipId: row.clip_id,
    cameraId: row.camera_id,
    protectStartAt: new Date(row.protect_start_at),
    protectEndAt: new Date(row.protect_end_at),
    clipStartAt: new Date(row.clip_start_at),
    clipEndAt: new Date(row.clip_end_at),
  }));
}

/** Candidate clips for one Protect event (internal ID). */
export function findClipCandidatesForProtectEvent(protectEventId: string, toleranceMs: number, db: DbExecutor) {
  return findClipMatchCandidates(toleranceMs, db, { protectEventId });
}

/** Candidate Protect events for one clip. */
export function findProtectEventCandidatesForClip(clipId: string, toleranceMs: number, db: DbExecutor) {
  return findClipMatchCandidates(toleranceMs, db, { clipId });
}

/**
 * Pairs of closed Protect events of different cameras that share a detection type and are at
 * most `toleranceMs` apart (multi-camera candidates), each pair once (a.id < b.id).
 */
export async function findMultiCameraCandidates(
  toleranceMs: number,
  db: DbExecutor,
): Promise<{ a: string; b: string }[]> {
  // Longest Protect event as a parameter, for an index range on start_at (see above).
  const longest = await db.execute<{ ms: number }>(sql`
    select coalesce(max(extract(epoch from end_at - start_at) * 1000), 0)::bigint as ms
    from protect_events where end_at is not null`);
  const lookBehindMs = toleranceMs + Number(longest.rows[0].ms);
  const result = await db.execute<{ a: string; b: string }>(sql`
    select a.id as a, b.id as b
    from protect_events a
    join protect_events b
      on b.camera_id <> a.camera_id
     and b.start_at <= a.end_at + make_interval(secs => ${toleranceMs / 1000})
     and b.start_at >= a.start_at - make_interval(secs => ${lookBehindMs / 1000})
     and b.end_at >= a.start_at - make_interval(secs => ${toleranceMs / 1000})
     and b.smart_detect_types && a.smart_detect_types
    where a.end_at is not null and b.end_at is not null
      and a.camera_id is not null and b.camera_id is not null
      and cardinality(a.smart_detect_types) > 0
      and a.id < b.id
    order by a.start_at, a.id, b.id`);
  return result.rows;
}

/** SQL form of `fallbackCameraKey` (matching/temporal-fallback.ts) for archived_clips alias `alias`. */
const FALLBACK_CAMERA_KEY = (alias: "a" | "b") =>
  sql.raw(`coalesce(${alias}.camera_id::text, 'name:' || ${alias}.camera_name)`);

/**
 * Clip pairs of different cameras whose starts are at most `startToleranceMs` and whose ends are
 * at most `endToleranceMs` apart (temporal fallback candidates), each pair once
 * (a.id < b.id). Pairs already in the same archive event are left out: their grouping is
 * re-checked via {@link findTemporalFallbackEventIds}. The start bound is an index range on
 * `start_at`, so each clip only looks at clips around its own start – no comparison of all
 * clips with all others. Overlap (IoU) and metadata are decided by the pure rules. Cameras are
 * compared by `fallbackCameraKey` (matching/temporal-fallback.ts): clips without a resolved
 * camera (no Protect yet) take part under their file-name camera.
 */
export async function findTemporalFallbackCandidates(
  startToleranceMs: number,
  endToleranceMs: number,
  db: DbExecutor,
): Promise<{ a: string; b: string }[]> {
  const result = await db.execute<{ a: string; b: string }>(sql`
    select a.id as a, b.id as b
    from archived_clips a
    join archived_clips b
      on b.start_at >= a.start_at - make_interval(secs => ${startToleranceMs / 1000})
     and b.start_at <= a.start_at + make_interval(secs => ${startToleranceMs / 1000})
     and b.id > a.id
     and ${FALLBACK_CAMERA_KEY("b")} <> ${FALLBACK_CAMERA_KEY("a")}
     and b.end_at >= a.end_at - make_interval(secs => ${endToleranceMs / 1000})
     and b.end_at <= a.end_at + make_interval(secs => ${endToleranceMs / 1000})
     and b.end_at > b.start_at
    where a.end_at > a.start_at
      and not exists (
        select 1 from archive_event_clips la
        join archive_event_clips lb on lb.archive_event_id = la.archive_event_id and lb.archived_clip_id = b.id
        where la.archived_clip_id = a.id)
    order by a.start_at, a.id, b.id`);
  return result.rows;
}

/** Archive events with more than one primary group, i.e. joined by the temporal fallback. */
export async function findTemporalFallbackEventIds(db: DbExecutor): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    select archive_event_id as id from (
      select archive_event_id, primary_group_id from archive_event_clips
      union
      select archive_event_id, primary_group_id from archive_event_protect_events
    ) links
    group by archive_event_id having count(*) > 1
    order by archive_event_id`);
  return result.rows.map((row) => row.id);
}

export interface ClipFacts {
  id: string;
  cameraId: string | null;
  /** Camera name from the file name (NFC-normalized, trimmed by the parser). */
  cameraName: string;
  startAt: Date;
  endAt: Date;
}

export async function loadClipFacts(clipIds: readonly string[], db: DbExecutor): Promise<ClipFacts[]> {
  if (clipIds.length === 0) return [];
  const result = await db.execute<{ id: string; camera_id: string | null; camera_name: string; start_at: string; end_at: string }>(
    sql`select id, camera_id, camera_name, start_at, end_at from archived_clips where id = any(${uuidArray(clipIds)})`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    cameraId: row.camera_id,
    cameraName: row.camera_name,
    startAt: new Date(row.start_at),
    endAt: new Date(row.end_at),
  }));
}

// --- graph input -----------------------------------------------------------------------------

export interface ProtectEventFacts {
  id: string;
  cameraId: string | null;
  startAt: Date;
  endAt: Date | null;
  smartDetectTypes: string[];
}

export async function loadProtectEventFacts(db: DbExecutor): Promise<ProtectEventFacts[]> {
  const result = await db.execute<{
    id: string;
    camera_id: string | null;
    start_at: string;
    end_at: string | null;
    smart_detect_types: string[];
  }>(sql`select id, camera_id, start_at, end_at, smart_detect_types from protect_events order by start_at, id`);
  return result.rows.map((row) => ({
    id: row.id,
    cameraId: row.camera_id,
    startAt: new Date(row.start_at),
    endAt: row.end_at ? new Date(row.end_at) : null,
    smartDetectTypes: row.smart_detect_types,
  }));
}

export interface Memberships {
  /** Archive events involved, with creation time (for the survivor choice). */
  events: { id: string; createdAt: Date }[];
  clipLinks: { eventId: string; clipId: string; groupId: string }[];
  protectEventLinks: { eventId: string; protectEventId: string; groupId: string }[];
}

/**
 * All archive events that contain any of the given clips or Protect events, plus `eventIds` –
 * and, transitively, everything else those events contain (until nothing new is found).
 */
export async function loadMemberships(
  clipIds: readonly string[],
  protectEventIds: readonly string[],
  db: DbExecutor,
  extraEventIds: readonly string[] = [],
): Promise<Memberships> {
  const clips = new Set(clipIds);
  const protect = new Set(protectEventIds);
  const eventIds = new Set<string>();
  let frontierClips = [...clips];
  let frontierProtect = [...protect];
  let frontierEvents = [...new Set(extraEventIds)];

  while (frontierClips.length > 0 || frontierProtect.length > 0 || frontierEvents.length > 0) {
    const found = await db.execute<{ id: string }>(sql`
      select archive_event_id as id from archive_event_clips where archived_clip_id = any(${uuidArray(frontierClips)})
      union
      select archive_event_id from archive_event_protect_events where protect_event_id = any(${uuidArray(frontierProtect)})`);
    const newEvents = [...new Set([...frontierEvents, ...found.rows.map((row) => row.id)])].filter((id) => !eventIds.has(id));
    frontierEvents = [];
    newEvents.forEach((id) => eventIds.add(id));
    if (newEvents.length === 0) break;
    const members = await db.execute<{ kind: "clip" | "protect"; id: string }>(sql`
      select 'clip' as kind, archived_clip_id as id from archive_event_clips where archive_event_id = any(${uuidArray(newEvents)})
      union
      select 'protect', protect_event_id from archive_event_protect_events where archive_event_id = any(${uuidArray(newEvents)})`);
    frontierClips = [];
    frontierProtect = [];
    for (const { kind, id } of members.rows) {
      const set = kind === "clip" ? clips : protect;
      if (!set.has(id)) {
        set.add(id);
        (kind === "clip" ? frontierClips : frontierProtect).push(id);
      }
    }
  }

  const ids = [...eventIds];
  // Sequential on purpose: `db` may be a transaction (one connection).
  const events = await db.execute<{ id: string; created_at: string }>(
    sql`select id, created_at from archive_events where id = any(${uuidArray(ids)}) order by created_at, id`,
  );
  const clipLinks = await db.execute<{ event_id: string; clip_id: string; group_id: string }>(
    sql`select archive_event_id as event_id, archived_clip_id as clip_id, primary_group_id as group_id
        from archive_event_clips where archive_event_id = any(${uuidArray(ids)})`,
  );
  const protectEventLinks = await db.execute<{ event_id: string; protect_event_id: string; group_id: string }>(
    sql`select archive_event_id as event_id, protect_event_id, primary_group_id as group_id
        from archive_event_protect_events where archive_event_id = any(${uuidArray(ids)})`,
  );
  return {
    events: events.rows.map((row) => ({ id: row.id, createdAt: new Date(row.created_at) })),
    clipLinks: clipLinks.rows.map((row) => ({ eventId: row.event_id, clipId: row.clip_id, groupId: row.group_id })),
    protectEventLinks: protectEventLinks.rows.map((row) => ({
      eventId: row.event_id,
      protectEventId: row.protect_event_id,
      groupId: row.group_id,
    })),
  };
}

// --- archive-only events for the rest ----------------------------------------------------------

/**
 * Gives every clip that belongs to no archive event its own `archiveOnly` event, set-based and
 * in batches (each batch one atomic statement). Returns the number of created events.
 */
export async function createArchiveOnlyEventsForUnlinkedClips(db: DbExecutor, batchSize = 1000): Promise<number> {
  let created = 0;
  // Keyset pagination over (start_at, id): each batch continues after the previous one
  // instead of searching the whole table again.
  let after: { startAt: string; id: string } | undefined;
  for (;;) {
    const result = await db.execute<{ n: number; last_start: string | null; last_id: string | null }>(sql`
      with batch as materialized (
        select c.id as clip_id, uuidv7() as event_id, c.start_at, c.end_at
        from archived_clips c
        where not exists (select 1 from archive_event_clips l where l.archived_clip_id = c.id)
          ${after ? sql`and (c.start_at, c.id) > (${after.startAt}::timestamptz, ${after.id}::uuid)` : sql``}
        order by c.start_at, c.id
        limit ${batchSize}
      ),
      events as (
        insert into archive_events (id, start_at, end_at, metadata_status)
        select event_id, start_at, end_at, 'archiveOnly' from batch
        returning id
      ),
      links as (
        insert into archive_event_clips (archive_event_id, archived_clip_id, primary_group_id)
        select b.event_id, b.clip_id, b.event_id from batch b join events e on e.id = b.event_id
        returning 1
      ),
      last as (select start_at, clip_id from batch order by start_at desc, clip_id desc limit 1)
      select (select count(*)::int from links) as n,
             (select start_at from last) as last_start,
             (select clip_id from last) as last_id`);
    const { n, last_start: lastStart, last_id: lastId } = result.rows[0];
    created += n;
    if (n < batchSize || !lastStart || !lastId) return created;
    after = { startAt: new Date(lastStart).toISOString(), id: lastId };
  }
}

export async function countReconciliationTotals(db: DbExecutor): Promise<{ clips: number; protectEvents: number }> {
  const result = await db.execute<{ clips: number; protect_events: number }>(sql`
    select (select count(*)::int from archived_clips) as clips,
           (select count(*)::int from protect_events) as protect_events`);
  return { clips: result.rows[0].clips, protectEvents: result.rows[0].protect_events };
}
