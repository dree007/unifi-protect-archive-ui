import "server-only";

import { and, desc, eq, getTableColumns, gte, lt, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/server/db/client";
import { archivedClips, type ArchivedClipRow } from "@/server/db/schema";
import { excluded } from "@/server/db/sql";
import type { DbExecutor } from "@/server/db/types";

/** Metadata of one MP4 file as found by the NAS indexer. */
export interface ArchivedClipInput {
  cameraId?: string | null;
  cameraName: string;
  startAt: Date;
  endAt: Date;
  durationMs: number;
  /** POSIX path relative to ARCHIVE_ROOT. */
  filePath: string;
  fileName: string;
  fileSizeBytes?: number | null;
  fileModifiedAt?: Date | null;
  dayDirectory: string;
  /** When the file was seen; the indexer passes its scan's start time. Defaults to now. */
  seenAt?: Date;
}

export type ClipWriteOutcome = "inserted" | "updated" | "unchanged";

/**
 * Columns that describe the file and its parsed name. A change in any of them counts as an
 * update; `last_seen_at` alone does not.
 */
const CONTENT_COLUMNS = [
  archivedClips.cameraName,
  archivedClips.startAt,
  archivedClips.endAt,
  archivedClips.durationMs,
  archivedClips.fileName,
  archivedClips.fileSizeBytes,
  archivedClips.fileModifiedAt,
  archivedClips.dayDirectory,
].map((column) => column.name);

const row = (alias: string) => sql.raw(`(${CONTENT_COLUMNS.map((name) => `${alias}."${name}"`).join(", ")})`);

function toValues(input: ArchivedClipInput) {
  const seenAt = input.seenAt ?? new Date();
  return {
    cameraId: input.cameraId ?? null,
    cameraName: input.cameraName,
    startAt: input.startAt,
    endAt: input.endAt,
    durationMs: input.durationMs,
    filePath: input.filePath,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes ?? null,
    fileModifiedAt: input.fileModifiedAt ?? null,
    dayDirectory: input.dayDirectory,
    discoveredAt: seenAt,
    lastSeenAt: seenAt,
  };
}

export async function findArchivedClipByPath(
  filePath: string,
  db: DbExecutor = getDb(),
): Promise<ArchivedClipRow | undefined> {
  const [found] = await db
    .select()
    .from(archivedClips)
    .where(eq(archivedClips.filePath, filePath))
    .limit(1);
  return found;
}

/** Inserts a new clip. Fails with a unique violation if the file path is already stored. */
export async function createArchivedClip(
  input: ArchivedClipInput,
  db: DbExecutor = getDb(),
): Promise<ArchivedClipRow> {
  const [created] = await db.insert(archivedClips).values(toValues(input)).returning();
  return created;
}

/**
 * Inserts new clips and refreshes known ones (same file path) in one statement:
 * - file metadata and parsed values are updated, `discoveredAt` is kept,
 * - `lastSeenAt` only moves forward,
 * - `updatedAt` changes only if file metadata or parsed values changed,
 * - an already resolved camera is not reset when the new data has none.
 *
 * Returns one entry per input (order not guaranteed) with the resulting row and whether it
 * was inserted, updated or unchanged. File paths within one call must be unique.
 */
export async function upsertArchivedClips(
  inputs: readonly ArchivedClipInput[],
  db: DbExecutor = getDb(),
): Promise<{ clip: ArchivedClipRow; outcome: ClipWriteOutcome }[]> {
  if (inputs.length === 0) return [];
  const contentChanged = sql`${row("archived_clips")} is distinct from ${row("excluded")}`;
  const rows = await db
    .insert(archivedClips)
    .values(inputs.map(toValues))
    .onConflictDoUpdate({
      target: archivedClips.filePath,
      set: {
        cameraId: sql`coalesce(${excluded(archivedClips.cameraId)}, ${archivedClips.cameraId})`,
        cameraName: excluded(archivedClips.cameraName),
        startAt: excluded(archivedClips.startAt),
        endAt: excluded(archivedClips.endAt),
        durationMs: excluded(archivedClips.durationMs),
        fileName: excluded(archivedClips.fileName),
        fileSizeBytes: excluded(archivedClips.fileSizeBytes),
        fileModifiedAt: excluded(archivedClips.fileModifiedAt),
        dayDirectory: excluded(archivedClips.dayDirectory),
        lastSeenAt: sql`greatest(${archivedClips.lastSeenAt}, ${excluded(archivedClips.lastSeenAt)})`,
        updatedAt: sql`case when ${contentChanged} then now() else ${archivedClips.updatedAt} end`,
      },
    })
    // PostgreSQL 18 `RETURNING old.*`: `old` is null for inserted rows.
    .returning({
      ...getTableColumns(archivedClips),
      inserted: sql<boolean>`old.id is null`,
      changed: sql<boolean>`${row("old")} is distinct from ${row("new")}`,
    });
  return rows.map(({ inserted, changed, ...clip }) => ({
    clip,
    outcome: inserted ? "inserted" : changed ? "updated" : "unchanged",
  }));
}

/**
 * Records that an already indexed file was seen by a scan although its metadata could not be
 * read (e.g. EACCES): only `lastSeenAt` moves forward; metadata and `updatedAt` stay as they
 * are, and unknown paths are not inserted. Returns whether a clip with this path exists.
 */
export async function markArchivedClipSeenByPath(
  filePath: string,
  seenAt: Date,
  db: DbExecutor = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(archivedClips)
    .set({
      lastSeenAt: sql`greatest(${archivedClips.lastSeenAt}, ${seenAt})`,
      // Explicitly kept: otherwise the `$onUpdate` hook would set it to now().
      updatedAt: sql`${archivedClips.updatedAt}`,
    })
    .where(eq(archivedClips.filePath, filePath))
    .returning({ id: archivedClips.id });
  return rows.length > 0;
}

/** Single-clip variant of {@link upsertArchivedClips}. */
export async function upsertArchivedClip(
  input: ArchivedClipInput,
  db: DbExecutor = getDb(),
): Promise<ArchivedClipRow> {
  const [result] = await upsertArchivedClips([input], db);
  return result.clip;
}

export interface ListArchivedClipsOptions {
  cameraId?: string;
  /** Inclusive lower bound on `startAt`. */
  from?: Date;
  /** Exclusive upper bound on `startAt`. */
  to?: Date;
  limit?: number;
}

/** Clips newest first, optionally filtered by camera and start time. */
export async function listArchivedClips(
  { cameraId, from, to, limit = 100 }: ListArchivedClipsOptions = {},
  db: DbExecutor = getDb(),
): Promise<ArchivedClipRow[]> {
  const conditions: SQL[] = [];
  if (cameraId) conditions.push(eq(archivedClips.cameraId, cameraId));
  if (from) conditions.push(gte(archivedClips.startAt, from));
  if (to) conditions.push(lt(archivedClips.startAt, to));
  return db
    .select()
    .from(archivedClips)
    .where(and(...conditions))
    .orderBy(desc(archivedClips.startAt), desc(archivedClips.id))
    .limit(limit);
}
