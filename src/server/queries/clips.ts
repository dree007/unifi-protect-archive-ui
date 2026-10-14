import "server-only";

import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/server/db/types";

import { toDateOrNull } from "./context";

/** What the media endpoints need of a clip. Read-only; the endpoints never change the database. */
export interface ClipMediaRow {
  id: string;
  /** Relative to ARCHIVE_ROOT, as stored by the indexer. */
  filePath: string;
  fileSizeBytes: number | null;
  fileModifiedAt: Date | null;
  durationMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClipId(value: string): boolean {
  return UUID.test(value);
}

/** `undefined` for unknown or malformed IDs. */
export async function getClipMedia(clipId: string, db: DbExecutor): Promise<ClipMediaRow | undefined> {
  if (!isClipId(clipId)) return undefined;
  const result = await db.execute<{
    id: string;
    file_path: string;
    file_size_bytes: string | number | null;
    file_modified_at: string | Date | null;
    duration_ms: number;
  }>(sql`
    select id, file_path, file_size_bytes, file_modified_at, duration_ms
    from archived_clips where id = ${clipId}::uuid`);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    filePath: row.file_path,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    fileModifiedAt: toDateOrNull(row.file_modified_at),
    durationMs: Number(row.duration_ms),
  };
}
