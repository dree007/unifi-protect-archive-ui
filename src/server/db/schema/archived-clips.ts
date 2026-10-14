import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { cameras } from "./cameras";
import { id, notBlank, timestamps, timestamptz } from "./columns";

/**
 * One MP4 file in the NAS archive. Only metadata is stored, never video data; the archive
 * itself is read-only for this application.
 *
 * `cameraId` is nullable: the indexer may find a clip before the camera is known from Protect,
 * and clips must outlive a removed camera (ON DELETE SET NULL). `cameraName` keeps the name
 * from the file name, so a clip stays attributable either way.
 */
export const archivedClips = pgTable(
  "archived_clips",
  {
    id: id(),
    cameraId: uuid("camera_id").references(() => cameras.id, { onDelete: "set null" }),
    cameraName: text("camera_name").notNull(),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /**
     * POSIX path relative to ARCHIVE_ROOT, e.g. `2026-03-29/Einfahrt … .mp4`; the clip's
     * identity. Relative so that a different mount point does not make every clip "new".
     */
    filePath: text("file_path").notNull().unique(),
    fileName: text("file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    fileModifiedAt: timestamptz("file_modified_at"),
    /** Name of the day folder the file was found in, e.g. `2026-10-06`. */
    dayDirectory: text("day_directory").notNull(),
    discoveredAt: timestamptz("discovered_at").notNull().defaultNow(),
    /** Last indexer run that still saw the file; lets a later step detect removed files. */
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    index("archived_clips_start_at_idx").on(table.startAt),
    index("archived_clips_camera_id_start_at_idx").on(table.cameraId, table.startAt),
    check("archived_clips_camera_name_not_blank", notBlank(table.cameraName)),
    check("archived_clips_file_path_not_blank", notBlank(table.filePath)),
    check(
      "archived_clips_file_path_relative",
      sql`${table.filePath} !~ '^/' and ${table.filePath} !~ '(^|/)\\.\\.(/|$)'`,
    ),
    check("archived_clips_file_name_not_blank", notBlank(table.fileName)),
    check("archived_clips_day_directory_not_blank", notBlank(table.dayDirectory)),
    check("archived_clips_end_not_before_start", sql`${table.endAt} >= ${table.startAt}`),
    check("archived_clips_duration_ms_non_negative", sql`${table.durationMs} >= 0`),
    check(
      "archived_clips_file_size_bytes_non_negative",
      sql`${table.fileSizeBytes} is null or ${table.fileSizeBytes} >= 0`,
    ),
  ],
);

export type ArchivedClipRow = typeof archivedClips.$inferSelect;
