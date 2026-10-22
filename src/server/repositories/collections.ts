import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  normalizeCollectionName,
  type CollectionSummary,
  type CurationError,
  type CurationResult,
} from "@/lib/collections";
import { getDb } from "@/server/db/client";
import { findPgError, PgErrorCode } from "@/server/db/errors";
import { archiveEventClips, collectionClips, collections, favoriteClips } from "@/server/db/schema";
import type { DbExecutor } from "@/server/db/types";

/**
 * Favorites and collections of archive events (situations). People always curate a whole event;
 * the rows are stored for each of its clips, because clip IDs survive rescans while event IDs do
 * not survive re-reconciliation (merged or split events keep their curation this way). An event
 * counts as favorite / member when at least one of its clips is.
 *
 * Writes are idempotent (setting a state that already holds is a success) and refuse unknown IDs
 * and invalid names with a typed error instead of throwing; anything unexpected still throws.
 * Only metadata rows change here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const ok = <T>(value: T): CurationResult<T> => ({ ok: true, value });
const fail = (error: CurationError): CurationResult<never> => ({ ok: false, error });

/** Maps the constraint violations a valid request can still hit (races, stale IDs). */
function constraintError(error: unknown): CurationError | undefined {
  const pgError = findPgError(error);
  if (pgError?.code === PgErrorCode.uniqueViolation && pgError.constraint === "collections_name_unique_idx") return "duplicate-name";
  if (pgError?.code === PgErrorCode.foreignKeyViolation) {
    return pgError.constraint?.includes("archived_clip_id") ? "event-not-found" : "collection-not-found";
  }
  return undefined;
}

async function guarded<T>(write: () => Promise<CurationResult<T>>): Promise<CurationResult<T>> {
  try {
    return await write();
  } catch (error) {
    const known = constraintError(error);
    if (known) return fail(known);
    throw error;
  }
}

/** Clip IDs of an event; `undefined` if the ID is malformed, unknown or the event has no clips yet. */
async function eventClipIds(eventId: unknown, db: DbExecutor): Promise<string[] | undefined> {
  if (!isId(eventId)) return undefined;
  const rows = await db
    .select({ id: archiveEventClips.archivedClipId })
    .from(archiveEventClips)
    .where(eq(archiveEventClips.archiveEventId, eventId));
  return rows.length > 0 ? rows.map((row) => row.id) : undefined;
}

/** Marks or unmarks an event as favorite (all of its clips). */
export async function setEventFavorite(eventId: unknown, favorite: boolean, db: DbExecutor = getDb()): Promise<CurationResult> {
  return guarded(async () => {
    const clipIds = await eventClipIds(eventId, db);
    if (!clipIds) return fail("event-not-found");
    if (favorite) await db.insert(favoriteClips).values(clipIds.map((archivedClipId) => ({ archivedClipId }))).onConflictDoNothing();
    else await db.delete(favoriteClips).where(inArray(favoriteClips.archivedClipId, clipIds));
    return ok(null);
  });
}

/** All collections by name (case-insensitive), each with its event count; one query. */
export async function listCollections(db: DbExecutor = getDb()): Promise<CollectionSummary[]> {
  const result = await db.execute<{ id: string; name: string; event_count: number }>(sql`
    select c.id, c.name,
           (select count(distinct e.archive_event_id)::int from collection_clips l
            join archive_event_clips e on e.archived_clip_id = l.archived_clip_id
            where l.collection_id = c.id) as event_count
    from collections c
    order by lower(c.name), c.id`);
  return result.rows.map((row) => ({ id: row.id, name: row.name, eventCount: Number(row.event_count) }));
}

export async function createCollection(rawName: unknown, db: DbExecutor = getDb()): Promise<CurationResult<CollectionSummary>> {
  const name = normalizeCollectionName(rawName);
  if (!name) return fail("invalid-name");
  return guarded(async () => {
    const [row] = await db.insert(collections).values({ name }).returning({ id: collections.id, name: collections.name });
    return ok({ ...row, eventCount: 0 });
  });
}

export async function renameCollection(collectionId: unknown, rawName: unknown, db: DbExecutor = getDb()): Promise<CurationResult> {
  if (!isId(collectionId)) return fail("collection-not-found");
  const name = normalizeCollectionName(rawName);
  if (!name) return fail("invalid-name");
  return guarded(async () => {
    const rows = await db.update(collections).set({ name }).where(eq(collections.id, collectionId)).returning({ id: collections.id });
    return rows.length > 0 ? ok(null) : fail("collection-not-found");
  });
}

/** Deletes the collection and its links; the clips themselves stay. */
export async function deleteCollection(collectionId: unknown, db: DbExecutor = getDb()): Promise<CurationResult> {
  if (!isId(collectionId)) return fail("collection-not-found");
  const rows = await db.delete(collections).where(eq(collections.id, collectionId)).returning({ id: collections.id });
  return rows.length > 0 ? ok(null) : fail("collection-not-found");
}

/** Adds an event (all of its clips) to a collection or removes it. */
export async function setEventInCollection(
  collectionId: unknown,
  eventId: unknown,
  member: boolean,
  db: DbExecutor = getDb(),
): Promise<CurationResult> {
  if (!isId(collectionId)) return fail("collection-not-found");
  return guarded(async () => {
    const clipIds = await eventClipIds(eventId, db);
    if (!clipIds) return fail("event-not-found");
    if (member) {
      await db
        .insert(collectionClips)
        .values(clipIds.map((archivedClipId) => ({ collectionId, archivedClipId })))
        .onConflictDoNothing();
      return ok(null);
    }
    await db
      .delete(collectionClips)
      .where(and(eq(collectionClips.collectionId, collectionId), inArray(collectionClips.archivedClipId, clipIds)));
    return ok(null);
  });
}

/** Whether an event is a favorite and the collections it belongs to (one query). */
export async function getEventCuration(
  eventId: unknown,
  db: DbExecutor = getDb(),
): Promise<{ favorite: boolean; collectionIds: string[] } | undefined> {
  if (!isId(eventId)) return undefined;
  const result = await db.execute<{ favorite: boolean; collection_ids: string[] }>(sql`
    select exists (select 1 from archive_event_clips e join favorite_clips f on f.archived_clip_id = e.archived_clip_id
                   where e.archive_event_id = a.id) as favorite,
           array(select distinct l.collection_id::text from archive_event_clips e
                 join collection_clips l on l.archived_clip_id = e.archived_clip_id
                 where e.archive_event_id = a.id) as collection_ids
    from archive_events a where a.id = ${eventId}::uuid`);
  const row = result.rows[0];
  return row ? { favorite: row.favorite, collectionIds: row.collection_ids } : undefined;
}
