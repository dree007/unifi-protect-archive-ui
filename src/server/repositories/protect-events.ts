import "server-only";

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/server/db/client";
import { protectEvents, type ProtectEventRow } from "@/server/db/schema";
import { excluded } from "@/server/db/sql";
import type { DbExecutor } from "@/server/db/types";

/**
 * State of a Protect event as known after a WebSocket message (`add` or `update`).
 * The future WebSocket handler maps Protect's payload (`item.id`, `item.device`, `item.start`
 * in epoch ms, …) to this shape.
 */
export interface ProtectEventSnapshot {
  protectEventId: string;
  protectDeviceId: string;
  eventType: string;
  startAt: Date;
  /** Missing/`null` while the event is ongoing. */
  endAt?: Date | null;
  smartDetectTypes?: readonly string[];
  /** Resolved internal camera, if known. */
  cameraId?: string | null;
  /** When the message was received; defaults to now. */
  receivedAt?: Date;
}

export async function findProtectEventByProtectEventId(
  protectEventId: string,
  db: DbExecutor = getDb(),
): Promise<ProtectEventRow | undefined> {
  const [row] = await db
    .select()
    .from(protectEvents)
    .where(eq(protectEvents.protectEventId, protectEventId))
    .limit(1);
  return row;
}

/**
 * Idempotent write for every WebSocket message of an event, in a single atomic statement:
 * the first message inserts, later ones update the same row (keyed by `protectEventId`).
 *
 * Merge rules on update:
 * - `firstReceivedAt` is kept, `lastReceivedAt` only moves forward,
 * - `endAt` and `cameraId` are never reset to `null` by a message that lacks them,
 * - `smartDetectTypes` accumulate (union, first-seen order): detections made during an
 *   ongoing event are not lost if a later message reports fewer types.
 */
export async function upsertProtectEvent(
  snapshot: ProtectEventSnapshot,
  db: DbExecutor = getDb(),
): Promise<ProtectEventRow> {
  const receivedAt = snapshot.receivedAt ?? new Date();
  const [row] = await db
    .insert(protectEvents)
    .values({
      protectEventId: snapshot.protectEventId,
      protectDeviceId: snapshot.protectDeviceId,
      eventType: snapshot.eventType,
      startAt: snapshot.startAt,
      endAt: snapshot.endAt ?? null,
      smartDetectTypes: [...(snapshot.smartDetectTypes ?? [])],
      cameraId: snapshot.cameraId ?? null,
      firstReceivedAt: receivedAt,
      lastReceivedAt: receivedAt,
    })
    .onConflictDoUpdate({
      target: protectEvents.protectEventId,
      set: {
        protectDeviceId: excluded(protectEvents.protectDeviceId),
        eventType: excluded(protectEvents.eventType),
        startAt: excluded(protectEvents.startAt),
        endAt: sql`coalesce(${excluded(protectEvents.endAt)}, ${protectEvents.endAt})`,
        cameraId: sql`coalesce(${excluded(protectEvents.cameraId)}, ${protectEvents.cameraId})`,
        smartDetectTypes: sql`(
          select coalesce(array_agg(detect_type order by first_seen), '{}'::text[])
          from (
            select detect_type, min(seen) as first_seen
            from unnest(${protectEvents.smartDetectTypes} || ${excluded(protectEvents.smartDetectTypes)})
              with ordinality as merged(detect_type, seen)
            group by detect_type
          ) as distinct_types
        )`,
        lastReceivedAt: sql`greatest(${protectEvents.lastReceivedAt}, ${excluded(protectEvents.lastReceivedAt)})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}
