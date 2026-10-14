import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { applyArchiveEventPlan, createArchiveEventsWithMembers } from "@/server/repositories/archive-events";
import { upsertCamera, upsertCameras } from "@/server/repositories/cameras";

import { CAMERAS, integrity, primaryGroups, shape, world } from "./reconcile-world";

/** Synthetic constellation: Driveway and Doorbell recorded the same occurrence. */
const EINFAHRT = ["13:01:05", "13:02:18"] as const;
const KLINGEL = ["13:01:04", "13:02:18"] as const;

describe("temporal fallback: historic clips without Protect metadata", () => {
  it("joins the two existing archiveOnly events into one, keeping the older event's ID", async () => {
    const w = await world();
    const driveway = await w.clip("Driveway", ...EINFAHRT);
    const doorbell = await w.clip("Doorbell", ...KLINGEL);
    // State left by the previous version: one archiveOnly event per clip (Driveway's first).
    const [older] = await createArchiveEventsWithMembers([{ clipIds: [driveway.id], protectEventIds: [] }], w.db);
    await createArchiveEventsWithMembers([{ clipIds: [doorbell.id], protectEventIds: [] }], w.db);
    expect((await w.snapshot()).map((event) => event.status)).toEqual(["archiveOnly", "archiveOnly"]);

    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(shape(events)).toEqual([
      { status: "archiveOnly", start: "13:01:04", end: "13:02:18", clips: ["Doorbell 13:01:04", "Driveway 13:01:05"], protect: [] },
    ]);
    expect(events[0].id).toBe(older);
    // Provenance: two primary groups in one event = temporal fallback.
    expect((await primaryGroups(w.db)).get(older)).toEqual([["Doorbell 13:01:04"], ["Driveway 13:01:05"]]);
    expect(result).toMatchObject({
      archiveEventsCreated: 0,
      archiveEventsMerged: 1,
      archiveEventsSplit: 0,
      temporalCandidates: 1,
      temporalFallbackEvents: 1,
      temporalLinksAdded: 1,
      temporalLinksRemoved: 0,
      status: { archiveOnly: 1, matched: 0, pendingClip: 0 },
    });
    expect(await integrity(w.db)).toEqual({ clips: 2, clip_links: 2, protect: 0, protect_links: 0, empty: 0 });
  });

  it("groups freshly scanned clips in the first run already", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    const result = await w.reconcile();
    expect(shape(await w.snapshot())).toEqual([
      { status: "archiveOnly", start: "13:01:04", end: "13:02:18", clips: ["Doorbell 13:01:04", "Driveway 13:01:05"], protect: [] },
    ]);
    expect(result).toMatchObject({ archiveEventsCreated: 1, temporalFallbackEvents: 1, temporalLinksAdded: 1 });
  });

  it("groups three cameras without metadata and leaves a later clip alone (end-to-end constellation)", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.clip("Garden", "14:00:00", "14:00:30");
    await w.reconcile();
    const events = await w.snapshot();
    expect(shape(events)).toEqual([
      { status: "archiveOnly", start: "13:01:04", end: "13:02:18", clips: ["Doorbell 13:01:04", "Driveway 13:01:05"], protect: [] },
      { status: "archiveOnly", start: "14:00:00", end: "14:00:30", clips: ["Garden 14:00:00"], protect: [] },
    ]);
    const groups = await primaryGroups(w.db);
    expect(groups.get(events[0].id)).toHaveLength(2);
    expect(groups.get(events[1].id)).toHaveLength(1);
  });

  it("groups three cameras with nearly identical clips into one event", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.clip("Garden", "13:01:06", "13:02:19");
    const result = await w.reconcile();
    const events = await w.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].clips).toEqual(["Doorbell 13:01:04", "Driveway 13:01:05", "Garden 13:01:06"]);
    expect(result).toMatchObject({ temporalFallbackEvents: 1, temporalLinksAdded: 3 });
  });

  it("adds a clip scanned later to the existing fallback event", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.reconcile();
    const [before] = await w.snapshot();

    await w.clip("Garden", "13:01:06", "13:02:19");
    const result = await w.reconcile();
    const after = await w.snapshot();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, clips: ["Doorbell 13:01:04", "Driveway 13:01:05", "Garden 13:01:06"] });
    expect(result).toMatchObject({ archiveEventsCreated: 0, relationsCreated: 1, temporalLinksAdded: 2, temporalLinksRemoved: 0 });
  });

  it("does not chain consecutive segments of continuous recordings into one event", async () => {
    const w = await world();
    // Three cameras, ten 60 s segments each, all with identical boundaries.
    for (let i = 0; i < 10; i++) {
      const start = `13:${String(i).padStart(2, "0")}:00`;
      const end = `13:${String(i + 1).padStart(2, "0")}:00`;
      for (const camera of ["Doorbell", "Driveway", "Garden"]) await w.clip(camera, start, end);
    }
    await w.reconcile();
    const events = await w.snapshot();
    expect(events).toHaveLength(10);
    for (const event of events) {
      expect(event.clips.map((clip) => clip.split(" ")[0])).toEqual(["Doorbell", "Driveway", "Garden"]);
      expect(new Set(event.clips.map((clip) => clip.split(" ")[1])).size).toBe(1);
    }
  });

  it("never groups consecutive clips of the same camera", async () => {
    const w = await world();
    await w.clip("Garden", "13:00:00", "13:00:30");
    await w.clip("Garden", "13:00:02", "13:00:31");
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
  });

  it("keeps the camera assignment and the grouping when a camera is renamed later", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.reconcile();
    const before = await w.snapshot();

    await upsertCamera({ protectDeviceId: CAMERAS.Driveway, name: "Zufahrt", state: "online" }, w.db);
    const result = await w.reconcile();
    expect(await w.snapshot()).toEqual(before);
    expect(result).toMatchObject({ archiveEventsMerged: 0, archiveEventsSplit: 0, temporalLinksAdded: 0, temporalLinksRemoved: 0 });
  });

  it("does not group clips whose camera name is ambiguous (two cameras with the same name)", async () => {
    const w = await world();
    await upsertCameras(
      [
        { protectDeviceId: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Carport", state: "online" },
        { protectDeviceId: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Carport", state: "online" },
      ],
      w.db,
    );
    await w.clip("Carport", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    const result = await w.reconcile();
    expect(result.unresolvedCameraNames).toEqual(["Carport"]);
    expect(await w.snapshot()).toHaveLength(2);
  });
});

describe("temporal fallback: Protect metadata has priority", () => {
  it("groups by metadata when both cameras report the same detection – no extra fallback group", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("matched");
    expect((await primaryGroups(w.db)).get(events[0].id)).toHaveLength(1);
    expect(result).toMatchObject({ multiCameraEvents: 1, temporalFallbackEvents: 0, temporalLinksAdded: 0 });
  });

  it("keeps contradicting detections apart although the clips are nearly identical", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.protect("Driveway", ["vehicle"], "13:01:05", "13:01:19");
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    const result = await w.reconcile();

    expect(shape(await w.snapshot())).toEqual([
      { status: "matched", start: "13:01:04", end: "13:02:18", clips: ["Doorbell 13:01:04"], protect: ["Doorbell person 13:01:04"] },
      { status: "matched", start: "13:01:05", end: "13:02:18", clips: ["Driveway 13:01:05"], protect: ["Driveway vehicle 13:01:05"] },
    ]);
    expect(result).toMatchObject({ temporalFallbackEvents: 0, temporalRejectedByMetadata: 1 });
  });

  it("does not use the fallback when both have metadata but the metadata time rule fails", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    // Same type, but 40 s apart (more than the 3 s of the metadata rule).
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:10");
    await w.protect("Doorbell", ["person"], "13:01:50", "13:01:55");
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
  });

  it("joins a clip with metadata and one without by time – matched, but only one camera confirmed", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(shape(events)).toEqual([
      {
        status: "matched",
        start: "13:01:04",
        end: "13:02:18",
        clips: ["Doorbell 13:01:04", "Driveway 13:01:05"],
        protect: ["Driveway person 13:01:05"],
      },
    ]);
    // Two primary groups: Driveway confirmed by Protect, Doorbell joined by time.
    expect((await primaryGroups(w.db)).get(events[0].id)).toEqual([
      ["Doorbell 13:01:04"],
      ["Driveway 13:01:05", "pe Driveway person 13:01:05"],
    ]);
    expect(result).toMatchObject({ temporalFallbackEvents: 1, status: { matched: 1, archiveOnly: 0 } });
  });
});

describe("temporal fallback: later metadata", () => {
  it("confirms a fallback group when matching Protect events arrive later (same event, one group)", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.reconcile();
    const [fallback] = await w.snapshot();
    expect((await primaryGroups(w.db)).get(fallback.id)).toHaveLength(2);

    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Doorbell", ["person"], "13:01:04", "13:01:18");
    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(events).toEqual([
      {
        ...fallback,
        status: "matched",
        protect: ["Doorbell person 13:01:04", "Driveway person 13:01:05"],
      },
    ]);
    // Now one primary group: the metadata grouping replaced the fallback link.
    expect((await primaryGroups(w.db)).get(fallback.id)).toHaveLength(1);
    expect(result).toMatchObject({
      archiveEventsCreated: 0,
      archiveEventsMerged: 0,
      archiveEventsSplit: 0,
      relationsCreated: 2,
      temporalFallbackEvents: 0,
      temporalLinksRemoved: 1,
      temporalLinksSuperseded: 1,
    });
    expect(await integrity(w.db)).toEqual({ clips: 2, clip_links: 2, protect: 2, protect_links: 2, empty: 0 });
  });

  it("splits a fallback group when contradicting Protect events arrive later", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.reconcile();
    const [fallback] = await w.snapshot();

    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Doorbell", ["vehicle"], "13:01:04", "13:01:18");
    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(shape(events)).toEqual([
      { status: "matched", start: "13:01:04", end: "13:02:18", clips: ["Doorbell 13:01:04"], protect: ["Doorbell vehicle 13:01:04"] },
      { status: "matched", start: "13:01:05", end: "13:02:18", clips: ["Driveway 13:01:05"], protect: ["Driveway person 13:01:05"] },
    ]);
    // The part with the event's own primary group (its earliest recording, Doorbell) keeps the
    // ID, the other part is a new event.
    const groups = await primaryGroups(w.db);
    const kept = events.find((event) => event.id === fallback.id);
    expect(kept?.clips).toEqual(["Doorbell 13:01:04"]);
    for (const event of events) expect(groups.get(event.id)).toHaveLength(1);
    expect(result).toMatchObject({
      archiveEventsCreated: 1,
      archiveEventsSplit: 1,
      archiveEventsMerged: 0,
      temporalFallbackEvents: 0,
      temporalLinksRemoved: 1,
      temporalLinksSuperseded: 0,
    });
    expect(await integrity(w.db)).toEqual({ clips: 2, clip_links: 2, protect: 2, protect_links: 2, empty: 0 });

    // Stable afterwards.
    const again = await w.reconcile();
    expect(await w.snapshot()).toEqual(events);
    expect(again).toMatchObject({ archiveEventsCreated: 0, archiveEventsSplit: 0, archiveEventsMerged: 0, eventsRecalculated: 0 });
  });

  it("splits only the contradicting camera off a three-camera group", async () => {
    const w = await world();
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.clip("Garden", "13:01:06", "13:02:19");
    await w.reconcile();
    const [fallback] = await w.snapshot();

    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.protect("Garden", ["animal"], "13:01:06", "13:01:20");
    const result = await w.reconcile();

    const events = await w.snapshot();
    expect(events).toHaveLength(2);
    const kept = events.find((event) => event.id === fallback.id)!;
    expect(kept.clips).toEqual(["Doorbell 13:01:04", "Driveway 13:01:05"]);
    expect(events.find((event) => event.id !== fallback.id)!.clips).toEqual(["Garden 13:01:06"]);
    expect(result).toMatchObject({ archiveEventsSplit: 1, temporalLinksRemoved: 2, temporalFallbackEvents: 1 });
  });

  it("splits a fallback group when a clip changes so that the time rule no longer holds", async () => {
    const w = await world();
    const doorbell = await w.clip("Doorbell", ...KLINGEL);
    await w.clip("Driveway", ...EINFAHRT);
    await w.reconcile();
    expect(await w.snapshot()).toHaveLength(1);

    // The indexer re-read the file: it is much shorter than before.
    await w.db.execute(sql`update archived_clips set end_at = start_at + interval '20 s', duration_ms = 20000 where id = ${doorbell.id}::uuid`);
    const result = await w.reconcile();
    expect(await w.snapshot()).toHaveLength(2);
    expect(result).toMatchObject({ archiveEventsSplit: 1, temporalLinksRemoved: 1 });
  });
});

describe("temporal fallback: idempotence, dry run, atomicity", () => {
  /** Fallback groups, a mixed group, a metadata group, a conflict, and a lone clip. */
  async function mixedWorld() {
    const w = await world();
    await w.clip("Driveway", "09:00:05", "09:01:18");
    await w.clip("Doorbell", "09:00:04", "09:01:18");
    await w.clip("Garden", "09:00:06", "09:01:19");
    await w.clip("Driveway", ...EINFAHRT);
    await w.clip("Doorbell", ...KLINGEL);
    await w.protect("Driveway", ["person"], "13:01:05", "13:01:19");
    await w.clip("Driveway", "15:00:05", "15:01:18");
    await w.clip("Doorbell", "15:00:04", "15:01:18");
    await w.protect("Driveway", ["person"], "15:00:05", "15:00:19");
    await w.protect("Doorbell", ["person"], "15:00:04", "15:00:18");
    await w.clip("Driveway", "16:00:05", "16:01:18");
    await w.clip("Doorbell", "16:00:04", "16:01:18");
    await w.protect("Driveway", ["vehicle"], "16:00:05", "16:00:19");
    await w.protect("Doorbell", ["person"], "16:00:04", "16:00:18");
    await w.clip("Garden", "18:00:00", "18:00:30");
    return w;
  }

  it("changes nothing when run ten times on unchanged data", async () => {
    const w = await mixedWorld();
    const first = await w.reconcile();
    expect(first).toMatchObject({ temporalFallbackEvents: 2, multiCameraEvents: 1 });
    const snapshot = await w.snapshot();
    const groups = await primaryGroups(w.db);
    const updatedAt = await w.db.execute(sql`select id, updated_at from archive_events order by id`);
    expect(snapshot.map((event) => event.clips.length)).toEqual([3, 2, 2, 1, 1, 1]);

    for (let i = 0; i < 9; i++) {
      expect(await w.reconcile()).toMatchObject({
        relationsCreated: 0,
        archiveEventsCreated: 0,
        archiveEventsMerged: 0,
        archiveEventsSplit: 0,
        temporalLinksAdded: 0,
        temporalLinksRemoved: 0,
        temporalFallbackEventsChanged: 0,
        emptyEventsDeleted: 0,
        eventsRecalculated: 0,
        temporalFallbackEvents: 2,
      });
    }
    expect(await w.snapshot()).toEqual(snapshot);
    expect(await primaryGroups(w.db)).toEqual(groups);
    expect((await w.db.execute(sql`select id, updated_at from archive_events order by id`)).rows).toEqual(updatedAt.rows);
    expect(await integrity(w.db)).toEqual({ clips: 10, clip_links: 10, protect: 5, protect_links: 5, empty: 0 });
  });

  it("makes the same decisions in a dry run without writing anything", async () => {
    const w = await mixedWorld();
    await w.reconcile();
    // Changes for the next run: a split (conflict) and a new fallback group.
    await w.protect("Doorbell", ["vehicle"], "09:00:04", "09:00:18");
    await w.protect("Driveway", ["person"], "09:00:05", "09:00:19");
    await w.clip("Driveway", "20:00:05", "20:01:18");
    await w.clip("Doorbell", "20:00:04", "20:01:18");
    const before = await w.snapshot();
    const groupsBefore = await primaryGroups(w.db);

    const dry = await w.reconcile({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, archiveEventsSplit: 1, temporalLinksAdded: 1 });
    expect(await w.snapshot()).toEqual(before);
    expect(await primaryGroups(w.db)).toEqual(groupsBefore);

    const real = await w.reconcile();
    expect({ ...real, durationMs: 0, dryRun: true }).toEqual({ ...dry, durationMs: 0 });
  });

  it("rolls a failing merge/split back completely", async () => {
    const w = await world();
    const driveway = await w.clip("Driveway", ...EINFAHRT);
    const doorbell = await w.clip("Doorbell", ...KLINGEL);
    await w.reconcile();
    const before = await w.snapshot();
    const groupsBefore = await primaryGroups(w.db);

    // A split plan that references a clip which does not exist: the foreign key fails at the end.
    await expect(
      applyArchiveEventPlan(
        [
          { id: before[0].id, clips: [{ id: driveway.id, primaryGroupId: null }], protectEvents: [] },
          {
            clips: [
              { id: doorbell.id, primaryGroupId: null },
              { id: "00000000-0000-7000-8000-000000000000", primaryGroupId: null },
            ],
            protectEvents: [],
          },
        ],
        [],
        w.db,
      ),
    ).rejects.toThrow();
    expect(await w.snapshot()).toEqual(before);
    expect(await primaryGroups(w.db)).toEqual(groupsBefore);
  });
});
