import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { BACKGROUND_COMPONENTS, BACKGROUND_STATES, type BackgroundComponent, type BackgroundState } from "@/domain/background";

import { oneOf, timestamps, timestamptz } from "./columns";

/**
 * Current state of the background worker and its components: one row per component
 * (`worker`, `protect`, `archiveScan`, `reconciliation`), overwritten in place – not a history.
 * Scan details stay in `archive_scan_runs`; the last reconciliation summary lives in `details`.
 *
 * `instance_id` is the worker process that owns the row. A starting worker takes over every
 * row while holding the worker lock; later writes are conditional on that ID, so an old
 * instance can never overwrite the state of a newer one (docs/background-worker.md).
 */
export const backgroundComponentStatus = pgTable(
  "background_component_status",
  {
    component: text("component", { enum: BACKGROUND_COMPONENTS }).primaryKey(),
    instanceId: uuid("instance_id").notNull(),
    state: text("state").$type<BackgroundState>().notNull(),
    /** Liveness of the worker (written every heartbeat interval; worker row only). */
    heartbeatAt: timestamptz("heartbeat_at"),
    /** Start of the owning worker process. */
    instanceStartedAt: timestamptz("instance_started_at"),
    lastStartedAt: timestamptz("last_started_at"),
    lastSucceededAt: timestamptz("last_succeeded_at"),
    lastFailedAt: timestamptz("last_failed_at"),
    /** Sanitized (no secrets, no absolute paths). */
    lastErrorMessage: text("last_error_message"),
    /** Next scheduled run of a periodic job. */
    nextRunAt: timestamptz("next_run_at"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (table) => [
    check("background_component_status_component_valid", oneOf(table.component, BACKGROUND_COMPONENTS)),
    check("background_component_status_state_valid", oneOf(table.state, BACKGROUND_STATES)),
    check("background_component_status_details_object", sql`${table.details} is null or jsonb_typeof(${table.details}) = 'object'`),
  ],
);

export type BackgroundComponentStatusRow = typeof backgroundComponentStatus.$inferSelect;
export type { BackgroundComponent };
