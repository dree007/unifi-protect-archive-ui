import { relations } from "drizzle-orm";

import { archiveEventClips, archiveEventProtectEvents, archiveEvents } from "./archive-events";
import { archivedClips } from "./archived-clips";
import { cameras } from "./cameras";
import { protectEvents } from "./protect-events";

// Relations for Drizzle's relational query API (`db.query.*.findFirst({ with })`).
// They do not affect the database schema.

export const camerasRelations = relations(cameras, ({ many }) => ({
  archivedClips: many(archivedClips),
  protectEvents: many(protectEvents),
}));

export const archivedClipsRelations = relations(archivedClips, ({ one, many }) => ({
  camera: one(cameras, { fields: [archivedClips.cameraId], references: [cameras.id] }),
  archiveEventLinks: many(archiveEventClips),
}));

export const protectEventsRelations = relations(protectEvents, ({ one, many }) => ({
  camera: one(cameras, { fields: [protectEvents.cameraId], references: [cameras.id] }),
  archiveEventLinks: many(archiveEventProtectEvents),
}));

export const archiveEventsRelations = relations(archiveEvents, ({ many }) => ({
  clipLinks: many(archiveEventClips),
  protectEventLinks: many(archiveEventProtectEvents),
}));

export const archiveEventClipsRelations = relations(archiveEventClips, ({ one }) => ({
  archiveEvent: one(archiveEvents, {
    fields: [archiveEventClips.archiveEventId],
    references: [archiveEvents.id],
  }),
  clip: one(archivedClips, {
    fields: [archiveEventClips.archivedClipId],
    references: [archivedClips.id],
  }),
}));

export const archiveEventProtectEventsRelations = relations(
  archiveEventProtectEvents,
  ({ one }) => ({
    archiveEvent: one(archiveEvents, {
      fields: [archiveEventProtectEvents.archiveEventId],
      references: [archiveEvents.id],
    }),
    protectEvent: one(protectEvents, {
      fields: [archiveEventProtectEvents.protectEventId],
      references: [protectEvents.id],
    }),
  }),
);
