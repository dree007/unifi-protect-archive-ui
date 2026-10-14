import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { cameras } from "./cameras";
import {
  endNotBeforeStart,
  id,
  notBlank,
  smartDetectTypes,
  timestamps,
  timestamptz,
} from "./columns";

/**
 * Events received from the UniFi Protect WebSocket. Protect first sends `add` and then several
 * `update` messages with the same event ID, so rows are written by upsert on `protectEventId`.
 *
 * `protectDeviceId` is always kept as received; `cameraId` is the resolved camera (nullable:
 * the camera may be unknown yet or removed later, ON DELETE SET NULL).
 */
export const protectEvents = pgTable(
  "protect_events",
  {
    id: id(),
    protectEventId: text("protect_event_id").notNull().unique(),
    cameraId: uuid("camera_id").references(() => cameras.id, { onDelete: "set null" }),
    protectDeviceId: text("protect_device_id").notNull(),
    /** Protect event type, e.g. `smartDetectZone`. Free text: Protect defines the values. */
    eventType: text("event_type").notNull(),
    startAt: timestamptz("start_at").notNull(),
    /** `null` while the event is ongoing. */
    endAt: timestamptz("end_at"),
    smartDetectTypes: smartDetectTypes("smart_detect_types"),
    firstReceivedAt: timestamptz("first_received_at").notNull(),
    lastReceivedAt: timestamptz("last_received_at").notNull(),
    ...timestamps(),
  },
  (table) => [
    index("protect_events_protect_device_id_idx").on(table.protectDeviceId),
    index("protect_events_start_at_idx").on(table.startAt),
    index("protect_events_camera_id_start_at_idx").on(table.cameraId, table.startAt),
    check("protect_events_protect_event_id_not_blank", notBlank(table.protectEventId)),
    check("protect_events_protect_device_id_not_blank", notBlank(table.protectDeviceId)),
    check("protect_events_event_type_not_blank", notBlank(table.eventType)),
    check("protect_events_end_not_before_start", endNotBeforeStart(table.startAt, table.endAt)),
    check(
      "protect_events_received_order",
      sql`${table.lastReceivedAt} >= ${table.firstReceivedAt}`,
    ),
  ],
);

export type ProtectEventRow = typeof protectEvents.$inferSelect;
