import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import { ReconciliationAlreadyRunningError } from "@/server/matching/reconcile";
import { findArchivedClipByPath } from "@/server/repositories/archived-clips";
import { findArchiveEventForClip, findArchiveEventForProtectEvent } from "@/server/repositories/archive-events";
import { upsertCamera } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { at, CAMERAS, type CameraName, shape, world } from "./reconcile-world";

describe("reconciliation: archive event materialization", () => {
  it("turns an old clip without metadata into an archiveOnly event", async () => {
    const w = await world();
    await w.clip("Garden", "09:00:00", "09:00:40");
    const result = await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      { status: "archiveOnly", start: "09:00:00", end: "09:00:40", clips: ["Garden 09:00:00"], protect: [] },
    ]);
    expect(result).toMatchObject({ archiveEventsCreated: 1, clipCamerasResolved: 1, status: { archiveOnly: 1, matched: 0, pendingClip: 0 } });
  });

  it("turns a Protect event without clip into a pendingClip event, also while ongoing", async () => {
    const w = await world();
    await w.protect("Garden", ["person"], "09:00:04", "09:00:12");
    await w.protect("Doorbell", ["person"], "10:00:00", null);
    await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      { status: "pendingClip", start: "09:00:04", end: "09:00:12", clips: [], protect: ["Garden person 09:00:04"] },
      { status: "pendingClip", start: "10:00:00", end: null, clips: [], protect: ["Doorbell person 10:00:00"] },
    ]);
  });

  it("matches a clip and a Protect event of the same camera", async () => {
    const w = await world();
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.protect("Garden", ["person"], "13:05:04", "13:05:12");
    const result = await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      { status: "matched", start: "13:05:00", end: "13:05:20", clips: ["Garden 13:05:00"], protect: ["Garden person 13:05:04"] },
    ]);
    expect(result).toMatchObject({ clipEventMatches: 1, archiveEventsCreated: 1, relationsCreated: 2 });
  });

  it("never matches across cameras, even at the same time", async () => {
    const w = await world();
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.protect("Driveway", ["person"], "13:05:04", "13:05:12");
    await w.reconcile();
    expect((await w.snapshot()).map((event) => event.status)).toEqual(["archiveOnly", "pendingClip"]);
  });

  it("keeps the pendingClip event when its clip arrives later", async () => {
    const w = await world();
    const event = await w.protect("Garden", ["person"], "13:05:04", "13:05:12");
    await w.reconcile();
    const [pending] = await w.snapshot();

    const clip = await w.clip("Garden", "13:05:00", "13:05:20");
    const result = await w.reconcile();

    const [matched, ...rest] = await w.snapshot();
    expect(rest).toEqual([]);
    expect(matched).toMatchObject({ id: pending.id, status: "matched", clips: ["Garden 13:05:00"] });
    expect(result).toMatchObject({ archiveEventsCreated: 0, archiveEventsMerged: 0, relationsCreated: 1 });
    expect((await findArchiveEventForClip(clip.id, w.db))?.id).toBe(pending.id);
    expect((await findArchiveEventForProtectEvent(event.id, w.db))?.id).toBe(pending.id);
  });

  it("keeps the archiveOnly event when its Protect event arrives later", async () => {
    const w = await world();
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.reconcile();
    const [archiveOnly] = await w.snapshot();

    await w.protect("Garden", ["person"], "13:05:04", "13:05:12");
    await w.reconcile();

    expect(await w.snapshot()).toEqual([{ ...archiveOnly, status: "matched", protect: ["Garden person 13:05:04"] }]);
  });

  it("matches an ongoing Protect event only once its end is known, merging the two events", async () => {
    const w = await world();
    await w.clip("Garden", "13:05:00", "13:05:20");
    const ongoing = await w.protect("Garden", ["person"], "13:05:04", null);
    await w.reconcile();
    const [archiveOnly, pending] = await w.snapshot();
    expect([archiveOnly.status, pending.status]).toEqual(["archiveOnly", "pendingClip"]);

    // WebSocket update with the end; the next run links clip and event: X and Z merge.
    await w.protect("Garden", ["person"], "13:05:04", "13:05:12", ongoing.protectEventId);
    const result = await w.reconcile();

    expect(result).toMatchObject({ archiveEventsMerged: 1, archiveEventsCreated: 0 });
    // Survivor: the older event (archiveOnly was created first in the same run? both in run 1 → stable order).
    const after = await w.snapshot();
    expect(after).toHaveLength(1);
    expect([archiveOnly.id, pending.id]).toContain(after[0].id);
    expect(after[0]).toMatchObject({ status: "matched", start: "13:05:00", end: "13:05:20" });
  });

  it("merges into the event created first", async () => {
    const w = await world();
    const ongoing = await w.protect("Garden", ["person"], "13:05:04", null);
    await w.reconcile(); // pendingClip event first
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.reconcile(); // archiveOnly event later (Protect event still open)
    const [first, second] = await w.snapshot();
    const older = first.status === "pendingClip" ? first : second;

    await w.protect("Garden", ["person"], "13:05:04", "13:05:12", ongoing.protectEventId);
    await w.reconcile();
    expect((await w.snapshot()).map((event) => event.id)).toEqual([older.id]);
  });

  it("links several Protect events in one clip to the same archive event", async () => {
    const w = await world();
    await w.clip("Garden", "13:01:00", "13:02:30");
    await w.protect("Garden", ["person"], "13:01:10", "13:01:20");
    await w.protect("Garden", ["person"], "13:01:50", "13:02:00");
    await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      {
        status: "matched",
        start: "13:01:00",
        end: "13:02:30",
        clips: ["Garden 13:01:00"],
        protect: ["Garden person 13:01:10", "Garden person 13:01:50"],
      },
    ]);
  });
});

describe("reconciliation: multi-camera grouping", () => {
  it("groups the synthetic constellation into exactly two archive events", async () => {
    const w = await world();
    await w.clip("Doorbell", "13:01:04", "13:02:18");
    await w.clip("Driveway", "13:01:05", "13:02:18");
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Garden", ["person"], "13:05:04", "13:05:12");

    const result = await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      {
        status: "matched",
        start: "13:01:04",
        end: "13:02:18",
        clips: ["Doorbell 13:01:04", "Driveway 13:01:05"],
        protect: ["Doorbell person 13:01:04", "Driveway person 13:01:05"],
      },
      { status: "matched", start: "13:05:00", end: "13:05:20", clips: ["Garden 13:05:00"], protect: ["Garden person 13:05:04"] },
    ]);
    expect(result).toMatchObject({ multiCameraEvents: 1, multiCameraJoins: 1, status: { matched: 2, archiveOnly: 0, pendingClip: 0 } });
  });

  it("does not group different detection types at the same time", async () => {
    const w = await world();
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    await w.protect("Driveway", ["vehicle"], "13:01:04", "13:01:18");
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
  });

  it("does not group events more than 3 s apart", async () => {
    const w = await world();
    await w.protect("Doorbell", ["person"], "13:01:00", "13:01:10");
    await w.protect("Driveway", ["person"], "13:01:14", "13:01:20");
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
  });

  it("does not group two events of the same camera by the multi-camera rule", async () => {
    const w = await world();
    await w.protect("Garden", ["person"], "13:01:10", "13:01:12");
    await w.protect("Garden", ["person"], "13:01:10", "13:01:12");
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
  });

  it("groups three cameras transitively within 30 s", async () => {
    const w = await world();
    await w.protect("Doorbell", ["person"], "13:01:00", "13:01:05");
    await w.protect("Driveway", ["person", "vehicle"], "13:01:07", "13:01:12");
    await w.protect("Garden", ["vehicle"], "13:01:14", "13:01:20");
    const result = await w.reconcile();
    expect(await w.snapshot()).toHaveLength(1);
    expect(result.multiCameraEvents).toBe(1);
  });

  it("keeps a long chain apart beyond 30 s", async () => {
    const w = await world();
    const cameras: CameraName[] = ["Doorbell", "Driveway", "Garden"];
    // 12 events, 2 s long, every 4 s, alternating cameras: neighbours are 2 s apart, the chain spans 46 s.
    for (let i = 0; i < 12; i++) {
      const start = new Date(at("13:00:00").getTime() + i * 4000).toISOString().slice(11, 19);
      const end = new Date(at("13:00:00").getTime() + i * 4000 + 2000).toISOString().slice(11, 19);
      await w.protect(cameras[i % 3], ["person"], start, end);
    }
    const result = await w.reconcile();
    const events = await w.snapshot();
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      const starts = event.protect.map((p) => at(p.split(" ").at(-1)!).getTime());
      expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(30_000);
    }
    expect(result.multiCameraRejectedBySpan).toBeGreaterThan(0);
  });

  it("does not group archiveOnly clips of different cameras by the metadata rule", async () => {
    const w = await world();
    await w.clip("Doorbell", "13:01:04", "13:01:30");
    await w.clip("Driveway", "13:01:04", "13:02:18");
    const result = await w.reconcile();
    // Different lengths: the temporal fallback does not apply either (docs/event-matching.md).
    expect((await w.snapshot()).map((event) => event.status)).toEqual(["archiveOnly", "archiveOnly"]);
    expect(result).toMatchObject({ multiCameraEvents: 0, temporalFallbackEvents: 0 });
  });
});

describe("reconciliation: cameras", () => {
  it("resolves clip cameras conservatively and keeps existing assignments after a rename", async () => {
    const w = await world();
    const exact = await w.clip("Garden", "09:00:00", "09:00:10");
    const upper = await w.clip("DOORBELL", "09:01:00", "09:01:10");
    const unknown = await w.clip("Carport", "09:02:00", "09:02:10");
    const result = await w.reconcile();

    expect((await findArchivedClipByPath(exact.filePath, w.db))?.cameraId).toBe(w.cameraId("Garden"));
    expect((await findArchivedClipByPath(upper.filePath, w.db))?.cameraId).toBe(w.cameraId("Doorbell"));
    expect((await findArchivedClipByPath(unknown.filePath, w.db))?.cameraId).toBeNull();
    expect(result).toMatchObject({ clipCamerasResolved: 2, unresolvedCameraNames: ["Carport"] });

    // Garden is renamed in Protect; a new camera takes the old name. The old clip stays with its camera.
    await upsertCamera({ protectDeviceId: CAMERAS.Garden, name: "Garden hinten", state: "online" }, w.db);
    await upsertCamera({ protectDeviceId: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Garden", state: "online" }, w.db);
    await w.reconcile();
    expect((await findArchivedClipByPath(exact.filePath, w.db))?.cameraId).toBe(w.cameraId("Garden"));
  });

  it("resolves the camera of Protect events stored before the camera was known", async () => {
    const w = await world();
    await upsertProtectEvent(
      {
        protectEventId: randomUUID(),
        protectDeviceId: CAMERAS.Garden,
        eventType: "smartDetectZone",
        startAt: at("13:05:04"),
        endAt: at("13:05:12"),
        smartDetectTypes: ["person"],
      },
      w.db,
    );
    await w.clip("Garden", "13:05:00", "13:05:20");
    const result = await w.reconcile();
    expect(result.protectEventCamerasResolved).toBe(1);
    expect((await w.snapshot()).map((event) => event.status)).toEqual(["matched"]);
  });
});

describe("reconciliation: idempotence, dry run, locking", () => {
  it("changes nothing when run ten times on unchanged data", async () => {
    const w = await world();
    await w.clip("Doorbell", "13:01:04", "13:02:18");
    await w.clip("Driveway", "13:01:05", "13:02:18");
    await w.clip("Garden", "09:00:00", "09:00:40");
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Garden", ["vehicle"], "15:00:00", null);
    await w.reconcile();
    const first = await w.snapshot();
    const updatedAt = await w.db.execute(sql`select id, updated_at from archive_events order by id`);

    for (let i = 0; i < 9; i++) {
      const result = await w.reconcile();
      expect(result).toMatchObject({
        clipCamerasResolved: 0,
        relationsCreated: 0,
        archiveEventsCreated: 0,
        archiveEventsMerged: 0,
        multiCameraJoins: 0,
        emptyEventsDeleted: 0,
        eventsRecalculated: 0,
      });
    }
    expect(await w.snapshot()).toEqual(first);
    expect((await w.db.execute(sql`select id, updated_at from archive_events order by id`)).rows).toEqual(updatedAt.rows);
    const links = await w.db.execute<{ n: number }>(sql`
      select (select count(*) from archive_event_clips) + (select count(*) from archive_event_protect_events) as n`);
    expect(Number(links.rows[0].n)).toBe(6);
  });

  it("reports the planned changes in a dry run without writing", async () => {
    const w = await world();
    await w.clip("Garden", "13:05:00", "13:05:20");
    await w.protect("Garden", ["person"], "13:05:04", "13:05:12");

    const dry = await w.reconcile({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, archiveEventsCreated: 1, clipCamerasResolved: 1, status: { matched: 1 } });
    expect(await w.snapshot()).toEqual([]);
    const clip = await w.db.execute<{ camera_id: string | null }>(sql`select camera_id from archived_clips`);
    expect(clip.rows[0].camera_id).toBeNull();

    const real = await w.reconcile();
    expect({ ...real, durationMs: 0, dryRun: true }).toEqual({ ...dry, durationMs: 0 });
  });

  it("refuses to run twice at the same time", async () => {
    const w = await world();
    const release = await tryAcquireAdvisoryLock(w.db, LOCK_KEYS.reconciliation);
    try {
      await expect(w.reconcile()).rejects.toBeInstanceOf(ReconciliationAlreadyRunningError);
    } finally {
      await release?.();
    }
    await expect(w.reconcile()).resolves.toMatchObject({ dryRun: false });
  });
});
