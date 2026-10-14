import { check, pgTable, text } from "drizzle-orm/pg-core";

import { CAMERA_STATES } from "@/domain/types";

import { id, notBlank, oneOf, smartDetectTypes, timestamps, timestamptz } from "./columns";

/**
 * Cameras known from UniFi Protect. The Protect device ID is the stable external identity;
 * names can be renamed in Protect at any time.
 */
export const cameras = pgTable(
  "cameras",
  {
    id: id(),
    protectDeviceId: text("protect_device_id").notNull().unique(),
    name: text("name").notNull(),
    model: text("model"),
    mac: text("mac"),
    /** Normalized for the UI: `online` only if Protect reports CONNECTED. */
    state: text("state", { enum: CAMERA_STATES }).notNull(),
    /**
     * Raw state as reported by Protect (e.g. `CONNECTED`, `DISCONNECTED`). Free text on purpose:
     * new Protect states must neither break the sync nor require a migration.
     */
    protectState: text("protect_state"),
    smartDetectTypes: smartDetectTypes("smart_detect_types"),
    /** Last time Protect reported the camera as connected. */
    lastSeenAt: timestamptz("last_seen_at"),
    ...timestamps(),
  },
  (table) => [
    check("cameras_protect_device_id_not_blank", notBlank(table.protectDeviceId)),
    check("cameras_name_not_blank", notBlank(table.name)),
    check("cameras_state_valid", oneOf(table.state, CAMERA_STATES)),
  ],
);

export type CameraRow = typeof cameras.$inferSelect;
