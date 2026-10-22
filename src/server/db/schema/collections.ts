import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { COLLECTION_NAME_MAX_LENGTH } from "@/lib/collections";

import { archivedClips } from "./archived-clips";
import { id, notBlank, timestamps, timestamptz } from "./columns";

/**
 * Favorites and collections are pure metadata about archived clips (docs/database.md). They
 * reference the clip row, whose ID stays stable across scans (identity = file path), and are
 * instance-wide: the application has no user accounts. Deleting a clip row removes only these
 * links (CASCADE); nothing here ever touches the NAS.
 */

/** A favorited clip. The primary key makes a clip a favorite at most once. */
export const favoriteClips = pgTable("favorite_clips", {
  archivedClipId: uuid("archived_clip_id")
    .primaryKey()
    .references(() => archivedClips.id, { onDelete: "cascade" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** A user-defined collection of clips, e.g. "Paketlieferungen". Names are unique ignoring case. */
export const collections = pgTable(
  "collections",
  {
    id: id(),
    name: text("name").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("collections_name_unique_idx").on(sql`lower(${table.name})`),
    check("collections_name_not_blank", notBlank(table.name)),
    check("collections_name_length", sql`char_length(${table.name}) <= ${sql.raw(String(COLLECTION_NAME_MAX_LENGTH))}`),
  ],
);

/**
 * Collection ↔ ArchivedClip. Deleting either side removes only the link (CASCADE); the
 * composite primary key prevents duplicates and covers lookups by collection.
 */
export const collectionClips = pgTable(
  "collection_clips",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    archivedClipId: uuid("archived_clip_id")
      .notNull()
      .references(() => archivedClips.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.archivedClipId] }),
    index("collection_clips_archived_clip_id_idx").on(table.archivedClipId),
  ],
);

export type CollectionRow = typeof collections.$inferSelect;
