import "server-only";

import { asc, eq, sql, type SQL } from "drizzle-orm";

import type { MetadataStatus } from "@/domain/types";
import { getDb } from "@/server/db/client";
import {
  archiveEventClips,
  archiveEventProtectEvents,
  archiveEvents,
  type ArchivedClipRow,
  type ArchiveEventRow,
  type ProtectEventRow,
} from "@/server/db/schema";
import { uuidArray } from "@/server/db/sql";
import type { DbExecutor } from "@/server/db/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArchiveEventInput {
  startAt: Date;
  endAt?: Date | null;
  metadataStatus: MetadataStatus;
}

export interface ArchiveEventWithLinks extends ArchiveEventRow {
  /** Linked clips, earliest first. */
  clips: ArchivedClipRow[];
  /** Linked Protect events, earliest first. */
  protectEvents: ProtectEventRow[];
}

export async function createArchiveEvent(
  input: ArchiveEventInput,
  db: DbExecutor = getDb(),
): Promise<ArchiveEventRow> {
  const [row] = await db
    .insert(archiveEvents)
    .values({ startAt: input.startAt, endAt: input.endAt ?? null, metadataStatus: input.metadataStatus })
    .returning();
  return row;
}

/** Loads an archive event with its clips and Protect events; `undefined` for unknown IDs. */
export async function findArchiveEventById(
  id: string,
  db: DbExecutor = getDb(),
): Promise<ArchiveEventWithLinks | undefined> {
  // IDs come from URLs later; a malformed one is "not found", not a database error.
  if (!UUID_PATTERN.test(id)) return undefined;

  const event = await db.query.archiveEvents.findFirst({
    where: eq(archiveEvents.id, id),
    with: {
      clipLinks: { with: { clip: true } },
      protectEventLinks: { with: { protectEvent: true } },
    },
  });
  if (!event) return undefined;

  const { clipLinks, protectEventLinks, ...row } = event;
  const byStart = (a: { startAt: Date }, b: { startAt: Date }) =>
    a.startAt.getTime() - b.startAt.getTime();
  return {
    ...row,
    clips: clipLinks.map((link) => link.clip).sort(byStart),
    protectEvents: protectEventLinks.map((link) => link.protectEvent).sort(byStart),
  };
}

/**
 * Links a clip to an archive event. Idempotent: returns `false` if the link already existed.
 * `primaryGroupId` defaults to the event's own group (its ID).
 */
export async function attachClipToArchiveEvent(
  archiveEventId: string,
  archivedClipId: string,
  db: DbExecutor = getDb(),
  primaryGroupId: string = archiveEventId,
): Promise<boolean> {
  const inserted = await db
    .insert(archiveEventClips)
    .values({ archiveEventId, archivedClipId, primaryGroupId })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

/**
 * Links a Protect event (internal `protect_events.id`, not the external Protect event ID)
 * to an archive event. Idempotent: returns `false` if the link already existed.
 * `primaryGroupId` defaults to the event's own group (its ID).
 */
export async function attachProtectEventToArchiveEvent(
  archiveEventId: string,
  protectEventId: string,
  db: DbExecutor = getDb(),
  primaryGroupId: string = archiveEventId,
): Promise<boolean> {
  const inserted = await db
    .insert(archiveEventProtectEvents)
    .values({ archiveEventId, protectEventId, primaryGroupId })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

/** The archive event a clip belongs to (the oldest, should there be several). */
export async function findArchiveEventForClip(
  archivedClipId: string,
  db: DbExecutor = getDb(),
): Promise<ArchiveEventRow | undefined> {
  const [row] = await db
    .select({ event: archiveEvents })
    .from(archiveEventClips)
    .innerJoin(archiveEvents, eq(archiveEvents.id, archiveEventClips.archiveEventId))
    .where(eq(archiveEventClips.archivedClipId, archivedClipId))
    .orderBy(asc(archiveEvents.createdAt), asc(archiveEvents.id))
    .limit(1);
  return row?.event;
}

/** The archive event a Protect event (internal ID) belongs to (the oldest, should there be several). */
export async function findArchiveEventForProtectEvent(
  protectEventId: string,
  db: DbExecutor = getDb(),
): Promise<ArchiveEventRow | undefined> {
  const [row] = await db
    .select({ event: archiveEvents })
    .from(archiveEventProtectEvents)
    .innerJoin(archiveEvents, eq(archiveEvents.id, archiveEventProtectEvents.archiveEventId))
    .where(eq(archiveEventProtectEvents.protectEventId, protectEventId))
    .orderBy(asc(archiveEvents.createdAt), asc(archiveEvents.id))
    .limit(1);
  return row?.event;
}

/**
 * The single definition of an archive event's derived values (docs/event-matching.md):
 * - start = earliest start of all linked clips and Protect events,
 * - end = latest known end (NULL only if nothing linked has an end yet),
 * - status: clip(s) + Protect event(s) → matched, only clips → archiveOnly,
 *   only Protect events → pendingClip.
 *
 * `clipStats`/`protectStats` aggregate the links per event; for all events they are computed
 * once with a grouped (hash) aggregation instead of one lookup per event, which stays fast
 * regardless of table statistics.
 */
function statsSql(clipStats: SQL, protectStats: SQL, filter: SQL): SQL {
  return sql`
    select e.id,
      least(c.min_start, p.min_start) as start_at,
      greatest(c.max_end, p.max_end) as end_at,
      case
        when coalesce(c.n, 0) > 0 and coalesce(p.n, 0) > 0 then 'matched'
        when coalesce(c.n, 0) > 0 then 'archiveOnly'
        else 'pendingClip'
      end as metadata_status,
      coalesce(c.n, 0) + coalesce(p.n, 0) as links
    from archive_events e
    left join (${clipStats}) c on c.id = e.id
    left join (${protectStats}) p on p.id = e.id
    where ${filter}`;
}

const clipStatsFor = (filter: SQL) => sql`
  select l.archive_event_id as id, count(*)::int as n, min(ac.start_at) as min_start, max(ac.end_at) as max_end
  from archive_event_clips l join archived_clips ac on ac.id = l.archived_clip_id
  where ${filter} group by l.archive_event_id`;

const protectStatsFor = (filter: SQL) => sql`
  select l.archive_event_id as id, count(*)::int as n, min(pe.start_at) as min_start, max(pe.end_at) as max_end
  from archive_event_protect_events l join protect_events pe on pe.id = l.protect_event_id
  where ${filter} group by l.archive_event_id`;

/**
 * Recomputes start, end and status from the links – for the given events, or all events.
 * Writes only rows that actually differ (unchanged events keep their `updatedAt`).
 * Returns the number of updated events.
 */
export async function recalculateArchiveEvents(
  eventIds: readonly string[] | "all",
  db: DbExecutor = getDb(),
): Promise<number> {
  const stats =
    eventIds === "all"
      ? statsSql(clipStatsFor(sql`true`), protectStatsFor(sql`true`), sql`true`)
      : statsSql(
          clipStatsFor(sql`l.archive_event_id = any(${uuidArray(eventIds)})`),
          protectStatsFor(sql`l.archive_event_id = any(${uuidArray(eventIds)})`),
          sql`e.id = any(${uuidArray(eventIds)})`,
        );
  const result = await db.execute(sql`
    with stats as (${stats})
    update archive_events e
    set start_at = s.start_at, end_at = s.end_at, metadata_status = s.metadata_status, updated_at = now()
    from stats s
    where e.id = s.id and s.links > 0
      and (e.start_at, e.end_at, e.metadata_status) is distinct from (s.start_at, s.end_at, s.metadata_status)`);
  return result.rowCount ?? 0;
}

/**
 * Refreshes the planner statistics of the archive event tables after bulk changes, so that
 * the following queries do not run on plans made for (nearly) empty tables.
 */
export async function analyzeArchiveEventTables(db: DbExecutor = getDb()): Promise<void> {
  await db.execute(sql`analyze archive_events, archive_event_clips, archive_event_protect_events`);
}

/** Single-event variant of {@link recalculateArchiveEvents}. */
export async function recalculateArchiveEvent(eventId: string, db: DbExecutor = getDb()): Promise<boolean> {
  return (await recalculateArchiveEvents([eventId], db)) > 0;
}

/** Deletes archive events without any clip or Protect event. Returns how many. */
export async function deleteEmptyArchiveEvents(db: DbExecutor = getDb()): Promise<number> {
  const result = await db.execute(sql`
    delete from archive_events e
    where not exists (select 1 from archive_event_clips l where l.archive_event_id = e.id)
      and not exists (select 1 from archive_event_protect_events l where l.archive_event_id = e.id)`);
  return result.rowCount ?? 0;
}

export async function countArchiveEventsByStatus(db: DbExecutor = getDb()): Promise<Record<MetadataStatus, number>> {
  const rows = await db
    .select({ status: archiveEvents.metadataStatus, count: sql<number>`count(*)::int` })
    .from(archiveEvents)
    .groupBy(archiveEvents.metadataStatus);
  const counts: Record<MetadataStatus, number> = { matched: 0, archiveOnly: 0, pendingClip: 0 };
  for (const { status, count } of rows) counts[status] = count;
  return counts;
}

export interface PlannedMember {
  id: string;
  /** Primary group of the link; `null` = the event's own group (its ID). */
  primaryGroupId: string | null;
}

export interface PlannedArchiveEvent {
  /** Existing archive event that keeps its ID, or `undefined` for a new one. */
  id?: string;
  clips: readonly PlannedMember[];
  protectEvents: readonly PlannedMember[];
}

export interface ArchiveEventPlanResult {
  /** IDs of the planned events, in input order (new ones generated by PostgreSQL, uuidv7). */
  ids: string[];
  linksInserted: number;
  linksDeleted: number;
  /** Links that stayed with their event but changed their primary group. */
  linksRegrouped: number;
  eventsDeleted: number;
}

/**
 * Brings archive events into the planned state, atomically (one transaction, a savepoint if
 * `db` already is one) and set-based (a fixed number of statements for the whole batch):
 * creates the new events, gives every planned event exactly its planned links (missing ones
 * inserted, others deleted, primary groups corrected), deletes `deleteIds` (events merged into
 * others; their links go with them) and recomputes start/end/status. Merges and splits are both
 * just plans: a link is never removed without its replacement in the same transaction.
 *
 * Every event that currently holds one of the planned clips or Protect events must be part of
 * the plan (as planned event or in `deleteIds`); otherwise a member would end up twice.
 */
export async function applyArchiveEventPlan(
  events: readonly PlannedArchiveEvent[],
  deleteIds: readonly string[],
  db: DbExecutor = getDb(),
): Promise<ArchiveEventPlanResult> {
  if (events.length === 0 && deleteIds.length === 0) {
    return { ids: [], linksInserted: 0, linksDeleted: 0, linksRegrouped: 0, eventsDeleted: 0 };
  }
  return db.transaction(async (tx) => {
    const existing = events.flatMap((event) => (event.id ? [event.id] : []));
    // Lock the touched events (stable order) so concurrent changes cannot interleave.
    const locked = await tx.execute<{ id: string }>(sql`
      select id from archive_events where id = any(${uuidArray([...existing, ...deleteIds])})
      order by id for update`);
    if (locked.rows.length !== new Set([...existing, ...deleteIds]).size) {
      throw new Error("applyArchiveEventPlan: some archive events do not exist.");
    }

    const newCount = events.length - existing.length;
    const created =
      newCount === 0
        ? []
        : (
            await tx.execute<{ id: string }>(sql`
              with input as materialized (
                select uuidv7() as id, ord from generate_series(1, ${newCount}::int) as ord
              ),
              inserted as (
                -- placeholder start/status; recomputed from the links below
                insert into archive_events (id, start_at, metadata_status)
                select id, now(), 'pendingClip' from input
              )
              select id from input order by ord`)
          ).rows.map((row) => row.id);
    let next = 0;
    const ids = events.map((event) => event.id ?? created[next++]);

    const rows = (pick: (event: PlannedArchiveEvent) => readonly PlannedMember[]) => {
      const eventIds: string[] = [];
      const memberIds: string[] = [];
      const groupIds: string[] = [];
      events.forEach((event, index) => {
        for (const member of pick(event)) {
          eventIds.push(ids[index]);
          memberIds.push(member.id);
          groupIds.push(member.primaryGroupId ?? ids[index]);
        }
      });
      return sql`select * from unnest(${uuidArray(eventIds)}, ${uuidArray(memberIds)}, ${uuidArray(groupIds)})
        as planned(event_id, member_id, group_id)`;
    };

    const sync = async (table: "archive_event_clips" | "archive_event_protect_events", planned: SQL) => {
      const member = sql.raw(table === "archive_event_clips" ? "archived_clip_id" : "protect_event_id");
      const target = sql.raw(table);
      // Remove links of the planned events that are not planned (moved elsewhere or obsolete).
      const deleted = await tx.execute(sql`
        delete from ${target} l
        where l.archive_event_id = any(${uuidArray(ids)})
          and not exists (
            select 1 from (${planned}) p where p.event_id = l.archive_event_id and p.member_id = l.${member})`);
      const upserted = await tx.execute<{ inserted: boolean }>(sql`
        insert into ${target} (archive_event_id, ${member}, primary_group_id)
        select event_id, member_id, group_id from (${planned}) p
        on conflict (archive_event_id, ${member}) do update set primary_group_id = excluded.primary_group_id
        where ${target}.primary_group_id is distinct from excluded.primary_group_id
        returning old.primary_group_id is null as inserted`);
      const inserted = upserted.rows.filter((row) => row.inserted).length;
      return { deleted: deleted.rowCount ?? 0, inserted, regrouped: upserted.rows.length - inserted };
    };
    const clips = await sync("archive_event_clips", rows((event) => event.clips));
    const protect = await sync("archive_event_protect_events", rows((event) => event.protectEvents));

    // Merged-away events; their remaining links go with them (ON DELETE CASCADE).
    const removed =
      deleteIds.length === 0 ? 0 : ((await tx.execute(sql`delete from archive_events where id = any(${uuidArray(deleteIds)})`)).rowCount ?? 0);
    await recalculateArchiveEvents(ids, tx);
    return {
      ids,
      linksInserted: clips.inserted + protect.inserted,
      linksDeleted: clips.deleted + protect.deleted,
      linksRegrouped: clips.regrouped + protect.regrouped,
      eventsDeleted: removed,
    };
  });
}

export interface NewArchiveEventMembers {
  clipIds: readonly string[];
  protectEventIds: readonly string[];
}

/**
 * Creates one archive event per entry with the given links (each event one primary group),
 * set-based; see {@link applyArchiveEventPlan}. Returns the created event IDs (same order).
 */
export async function createArchiveEventsWithMembers(
  groups: readonly NewArchiveEventMembers[],
  db: DbExecutor = getDb(),
): Promise<string[]> {
  const own = (id: string): PlannedMember => ({ id, primaryGroupId: null });
  const result = await applyArchiveEventPlan(
    groups.map((group) => ({ clips: group.clipIds.map(own), protectEvents: group.protectEventIds.map(own) })),
    [],
    db,
  );
  return result.ids;
}
