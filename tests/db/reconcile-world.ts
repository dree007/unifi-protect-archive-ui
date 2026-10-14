import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "@/server/db/types";
import { reconcileArchive, type ReconcileOptions } from "@/server/matching/reconcile";
import { createArchivedClip } from "@/server/repositories/archived-clips";
import { upsertCameras } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { createIsolatedDb } from "./helpers";

/** Shared fixture of the reconciliation tests: an isolated database with the three synthetic cameras. */

export const DAY = "2026-03-29";
/** Local times on the test day, as UTC instants (offset irrelevant for matching). */
export const at = (time: string) => new Date(`${DAY}T${time}.000Z`);

export const CAMERAS = {
  Doorbell: "660000000000000000000003",
  Driveway: "660000000000000000000002",
  Garden: "660000000000000000000001",
} as const;
export type CameraName = keyof typeof CAMERAS;

/** A database with the three synthetic cameras plus helpers to add clips and Protect events. */
export async function world() {
  const { db } = await createIsolatedDb();
  const cameras = await upsertCameras(
    Object.entries(CAMERAS).map(([name, protectDeviceId]) => ({ protectDeviceId, name, state: "online" as const })),
    db,
  );
  const cameraId = (name: CameraName) => cameras.find((c) => c.camera.protectDeviceId === CAMERAS[name])!.camera.id;

  /** A NAS clip as the indexer stores it: camera only by name (resolved by the reconciliation). */
  const clip = (camera: string, start: string, end: string) => {
    const fileName = `${camera} ${start} - ${end} ${randomUUID().slice(0, 8)}.mp4`;
    return createArchivedClip(
      {
        cameraName: camera,
        startAt: at(start),
        endAt: at(end),
        durationMs: at(end).getTime() - at(start).getTime(),
        filePath: `${DAY}/${fileName}`,
        fileName,
        dayDirectory: DAY,
      },
      db,
    );
  };

  /** A Protect event as the collector stores it (camera resolved by device ID). */
  const protect = (camera: CameraName, types: string[], start: string, end: string | null, protectEventId: string = randomUUID()) =>
    upsertProtectEvent(
      {
        protectEventId,
        protectDeviceId: CAMERAS[camera],
        cameraId: cameraId(camera),
        eventType: "smartDetectZone",
        startAt: at(start),
        endAt: end === null ? null : at(end),
        smartDetectTypes: types,
      },
      db,
    );

  const reconcile = (options: Partial<ReconcileOptions> = {}) => reconcileArchive({ db, ...options });
  return { db, cameraId, clip, protect, reconcile, snapshot: () => snapshot(db) };
}

/** The complete archive event model, in a stable order and without volatile timestamps. */
export async function snapshot(db: Database) {
  const result = await db.execute<{
    id: string;
    status: string;
    start_at: string;
    end_at: string | null;
    clips: string[] | null;
    protect: string[] | null;
  }>(sql`
    select e.id, e.metadata_status as status, e.start_at, e.end_at,
      (select array_agg(c.camera_name || ' ' || to_char(c.start_at at time zone 'UTC', 'HH24:MI:SS') order by c.camera_name, c.start_at)
         from archive_event_clips l join archived_clips c on c.id = l.archived_clip_id where l.archive_event_id = e.id) as clips,
      (select array_agg(cam.name || ' ' || array_to_string(p.smart_detect_types, '+') || ' ' || to_char(p.start_at at time zone 'UTC', 'HH24:MI:SS') order by cam.name, p.start_at)
         from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
         left join cameras cam on cam.id = p.camera_id where l.archive_event_id = e.id) as protect
    from archive_events e
    order by e.start_at, e.id`);
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    start: new Date(row.start_at).toISOString().slice(11, 19),
    end: row.end_at ? new Date(row.end_at).toISOString().slice(11, 19) : null,
    clips: row.clips ?? [],
    protect: row.protect ?? [],
  }));
}

/** Snapshot without IDs, for comparing structure. */
export const shape = (events: Awaited<ReturnType<typeof snapshot>>) =>
  events.map((event) => ({ status: event.status, start: event.start, end: event.end, clips: event.clips, protect: event.protect }));


/**
 * Primary groups per archive event (by event ID): each group as its sorted member labels
 * ("Doorbell 13:01:04" for clips, "pe Doorbell person 13:01:04" for Protect events).
 * More than one group = joined by the temporal fallback.
 */
export async function primaryGroups(db: Database): Promise<Map<string, string[][]>> {
  const result = await db.execute<{ event_id: string; group_id: string; label: string }>(sql`
    select l.archive_event_id as event_id, l.primary_group_id as group_id,
           c.camera_name || ' ' || to_char(c.start_at at time zone 'UTC', 'HH24:MI:SS') as label
    from archive_event_clips l join archived_clips c on c.id = l.archived_clip_id
    union all
    select l.archive_event_id, l.primary_group_id,
           'pe ' || coalesce(cam.name, '?') || ' ' || array_to_string(p.smart_detect_types, '+') || ' ' ||
           to_char(p.start_at at time zone 'UTC', 'HH24:MI:SS')
    from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
    left join cameras cam on cam.id = p.camera_id`);
  const byEvent = new Map<string, Map<string, string[]>>();
  for (const row of result.rows) {
    const groups = byEvent.get(row.event_id) ?? new Map<string, string[]>();
    groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row.label]);
    byEvent.set(row.event_id, groups);
  }
  return new Map(
    [...byEvent].map(([eventId, groups]) => [
      eventId,
      [...groups.values()].map((labels) => labels.toSorted()).toSorted((a, b) => (a[0] < b[0] ? -1 : 1)),
    ]),
  );
}

/** Every link exactly once, and no event without links. */
export async function integrity(db: Database) {
  const result = await db.execute<{ clips: number; clip_links: number; protect: number; protect_links: number; empty: number }>(sql`
    select (select count(*)::int from archived_clips) as clips,
           (select count(*)::int from archive_event_clips) as clip_links,
           (select count(*)::int from protect_events) as protect,
           (select count(*)::int from archive_event_protect_events) as protect_links,
           (select count(*)::int from archive_events e
             where not exists (select 1 from archive_event_clips l where l.archive_event_id = e.id)
               and not exists (select 1 from archive_event_protect_events l where l.archive_event_id = e.id)) as empty`);
  return result.rows[0];
}
