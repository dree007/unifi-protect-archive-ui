import "server-only";

import { sql } from "drizzle-orm";

import type { BackgroundComponent } from "@/domain/background";
import type { BackgroundStatusModel } from "@/lib/view-models";
import { deriveBackgroundStatus, type StatusRow } from "@/server/view-models/background-status";
import { readHeartbeatStaleMs } from "@/server/worker/config";

import { toDate, toDateOrNull, type QueryContext } from "./context";

type Timestamp = string | Date;

/**
 * Operating state of the background worker for the system page: the four status rows plus the
 * heartbeat age by the database clock. One small query; no polling infrastructure.
 */
export async function getBackgroundStatus(
  context: QueryContext,
  { staleMs = readHeartbeatStaleMs(), archiveRoot = process.env.ARCHIVE_ROOT } = {},
): Promise<BackgroundStatusModel> {
  const result = await context.db.execute<{
    component: BackgroundComponent;
    instance_id: string;
    state: string;
    heartbeat_at: Timestamp | null;
    heartbeat_age_ms: string | number | null;
    instance_started_at: Timestamp | null;
    last_started_at: Timestamp | null;
    last_succeeded_at: Timestamp | null;
    last_failed_at: Timestamp | null;
    last_error_message: string | null;
    next_run_at: Timestamp | null;
    details: Record<string, unknown> | null;
    updated_at: Timestamp;
  }>(sql`
    select component, instance_id, state, heartbeat_at,
           (extract(epoch from now() - heartbeat_at) * 1000)::bigint as heartbeat_age_ms,
           instance_started_at, last_started_at, last_succeeded_at, last_failed_at, last_error_message,
           next_run_at, details, updated_at
    from background_component_status`);
  const rows: StatusRow[] = result.rows.map((row) => ({
    component: row.component,
    instanceId: row.instance_id,
    state: row.state,
    heartbeatAt: toDateOrNull(row.heartbeat_at),
    heartbeatAgeMs: row.heartbeat_age_ms === null ? null : Number(row.heartbeat_age_ms),
    instanceStartedAt: toDateOrNull(row.instance_started_at),
    lastStartedAt: toDateOrNull(row.last_started_at),
    lastSucceededAt: toDateOrNull(row.last_succeeded_at),
    lastFailedAt: toDateOrNull(row.last_failed_at),
    lastErrorMessage: row.last_error_message,
    nextRunAt: toDateOrNull(row.next_run_at),
    details: row.details,
    updatedAt: toDate(row.updated_at),
  }));
  return deriveBackgroundStatus(rows, { staleMs, now: context.now, format: context.format, archiveRoot });
}
