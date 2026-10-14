import { check, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

import { METADATA_STATUSES } from "@/domain/types";

import { archivedClips } from "./archived-clips";
import { endNotBeforeStart, id, oneOf, timestamps, timestamptz } from "./columns";
import { protectEvents } from "./protect-events";

/**
 * Our own logical unit: one real-world occurrence, possibly recorded by several cameras
 * (several clips) and reported by several Protect events. Clips and Protect events are linked
 * via explicit many-to-many join tables. Detection types are not duplicated here; they derive
 * from the linked Protect events.
 */
export const archiveEvents = pgTable(
  "archive_events",
  {
    id: id(),
    startAt: timestamptz("start_at").notNull(),
    /** `null` while a linked Protect event is still ongoing. */
    endAt: timestamptz("end_at"),
    metadataStatus: text("metadata_status", { enum: METADATA_STATUSES }).notNull(),
    ...timestamps(),
  },
  (table) => [
    index("archive_events_start_at_idx").on(table.startAt),
    // Leading status column also serves lookups by status alone (e.g. all `pendingClip`).
    index("archive_events_metadata_status_start_at_idx").on(table.metadataStatus, table.startAt),
    check("archive_events_metadata_status_valid", oneOf(table.metadataStatus, METADATA_STATUSES)),
    check("archive_events_end_not_before_start", endNotBeforeStart(table.startAt, table.endAt)),
  ],
);

/**
 * Primary group of a link (docs/event-matching.md, "Gruppierungsherkunft"): the clips and
 * Protect events of an archive event that belong together by Protect metadata (or a single
 * clip) share one primary group ID. An archive event with several primary groups was joined by
 * the temporal fallback – that join is re-checked on every reconciliation and can be undone,
 * a primary group is never split. Not a table of its own: the ID only labels the links; by
 * convention it is the ID of the archive event that created the group.
 */
const primaryGroupId = () => uuid("primary_group_id").notNull();

/**
 * ArchiveEvent ↔ ArchivedClip. Deleting either side removes only the link (CASCADE); the
 * composite primary key prevents duplicate links and covers lookups by archive event.
 */
export const archiveEventClips = pgTable(
  "archive_event_clips",
  {
    archiveEventId: uuid("archive_event_id")
      .notNull()
      .references(() => archiveEvents.id, { onDelete: "cascade" }),
    archivedClipId: uuid("archived_clip_id")
      .notNull()
      .references(() => archivedClips.id, { onDelete: "cascade" }),
    primaryGroupId: primaryGroupId(),
  },
  (table) => [
    primaryKey({ columns: [table.archiveEventId, table.archivedClipId] }),
    index("archive_event_clips_archived_clip_id_idx").on(table.archivedClipId),
  ],
);

/**
 * ArchiveEvent ↔ ProtectEvent. `protectEventId` references the internal `protect_events.id`
 * (not the external Protect event ID). Same delete and uniqueness rules as above.
 */
export const archiveEventProtectEvents = pgTable(
  "archive_event_protect_events",
  {
    archiveEventId: uuid("archive_event_id")
      .notNull()
      .references(() => archiveEvents.id, { onDelete: "cascade" }),
    protectEventId: uuid("protect_event_id")
      .notNull()
      .references(() => protectEvents.id, { onDelete: "cascade" }),
    primaryGroupId: primaryGroupId(),
  },
  (table) => [
    primaryKey({ columns: [table.archiveEventId, table.protectEventId] }),
    index("archive_event_protect_events_protect_event_id_idx").on(table.protectEventId),
  ],
);

export type ArchiveEventRow = typeof archiveEvents.$inferSelect;
