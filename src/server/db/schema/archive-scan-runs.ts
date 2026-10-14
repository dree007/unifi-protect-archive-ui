import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { id, notBlank, oneOf, timestamps, timestamptz } from "./columns";

export const ARCHIVE_SCAN_STATUSES = ["running", "completed", "failed"] as const;
export type ArchiveScanStatus = (typeof ARCHIVE_SCAN_STATUSES)[number];

const count = (name: string) => integer(name).notNull().default(0);

/**
 * History of full NAS archive scans. A scan stamps every clip it finds with
 * `last_seen_at = started_at` of its run, so after a *completed* run every clip with
 * `last_seen_at < started_at` was not found. Failed runs are never used for that.
 */
export const archiveScanRuns = pgTable(
  "archive_scan_runs",
  {
    id: id(),
    /** ARCHIVE_ROOT as configured for this run (for display and diagnostics). */
    archiveRoot: text("archive_root").notNull(),
    /**
     * Millisecond precision on purpose: clips get exactly this value as `last_seen_at` via a
     * JavaScript Date (ms). With now()'s microseconds, `last_seen_at < started_at` would hold
     * for clips seen by this very run.
     */
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date", precision: 3 })
      .notNull()
      .defaultNow(),
    finishedAt: timestamptz("finished_at"),
    status: text("status", { enum: ARCHIVE_SCAN_STATUSES }).notNull().default("running"),
    dayDirectoryCount: count("day_directory_count"),
    /** Clips inserted for the first time. */
    discoveredCount: count("discovered_count"),
    /** Known clips whose metadata changed. */
    updatedCount: count("updated_count"),
    unchangedCount: count("unchanged_count"),
    /** MP4 files that could not be indexed (e.g. unparseable name). */
    failedCount: count("failed_count"),
    /** Indexed with a warning (e.g. day folder does not match the start date). */
    warningCount: count("warning_count"),
    /** Clips not found by this run; only set for completed runs. */
    missingCount: integer("missing_count"),
    errorMessage: text("error_message"),
    ...timestamps(),
  },
  (table) => [
    index("archive_scan_runs_status_started_at_idx").on(table.status, table.startedAt),
    // At most one running scan; the indexer additionally serializes scans with an advisory lock.
    uniqueIndex("archive_scan_runs_single_running_idx")
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
    check("archive_scan_runs_status_valid", oneOf(table.status, ARCHIVE_SCAN_STATUSES)),
    check("archive_scan_runs_archive_root_not_blank", notBlank(table.archiveRoot)),
    check(
      "archive_scan_runs_finished_when_done",
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    check(
      "archive_scan_runs_counts_non_negative",
      sql`least(${table.dayDirectoryCount}, ${table.discoveredCount}, ${table.updatedCount}, ${table.unchangedCount}, ${table.failedCount}, ${table.warningCount}, coalesce(${table.missingCount}, 0)) >= 0`,
    ),
  ],
);

export type ArchiveScanRunRow = typeof archiveScanRuns.$inferSelect;
