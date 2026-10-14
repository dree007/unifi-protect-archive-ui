import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ARCHIVE_FILTERS, type ArchiveFilters } from "@/lib/archive-filters";
import type { EventCardModel } from "@/lib/view-models";
import type { Database } from "@/server/db/types";
import { reconcileArchive } from "@/server/matching/reconcile";
import { getArchivePage, getCameraFilterOptions } from "@/server/queries/archive";
import { queryContext, type QueryContext } from "@/server/queries/context";
import { createArchivedClip } from "@/server/repositories/archived-clips";
import { upsertCameras } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { createIsolatedDb } from "./helpers";

/**
 * Regression tests for the archive's text search and period filters (real PostgreSQL):
 * exact day boundaries in Europe/Berlin incl. both DST changes of 2026, multi-camera events,
 * pending and archive-only events, identical start times, combinations and keyset pagination.
 */

const TZ = "Europe/Berlin";
/** "Now": Sunday 25 Oct 2026, 11:00 Berlin – the day the clocks go back (25 hours). */
const NOW = new Date("2026-10-25T10:00:00Z");

const CAMS = {
  Driveway: "660000000000000000000002",
  Garden: "660000000000000000000001",
  Doorbell: "660000000000000000000003",
  // Real camera names of the user's archive, deliberately with one "r".
  Garage: "64eaf57c01a2fe03870003f1",
  "Garage 2": "65ddf35203abc803e4010d16",
} as const;
type Cam = keyof typeof CAMS;

// Every event gets a unique tag in its clip file name (`Garden [multi].mp4`); the tests compare
// tags, not just counts.

async function buildFixture(db: Database) {
  const cameras = await upsertCameras(
    Object.entries(CAMS).map(([name, protectDeviceId]) => ({
      protectDeviceId,
      name,
      state: "online",
      protectState: "CONNECTED",
      smartDetectTypes: ["person", "vehicle", "package"],
      lastSeenAt: NOW,
    })),
    db,
  );
  const cameraId = (cam: Cam) => cameras.find((c) => c.camera.protectDeviceId === CAMS[cam])!.camera.id;

  const clip = (cam: Cam, startIso: string, tag: string, seconds = 20) => {
    const startAt = new Date(startIso);
    const day = startAt.toISOString().slice(0, 10);
    const fileName = `${cam} [${tag}].mp4`;
    return createArchivedClip(
      {
        cameraName: cam,
        startAt,
        endAt: new Date(startAt.getTime() + seconds * 1000),
        durationMs: seconds * 1000,
        filePath: `${day}/${fileName}`,
        fileName,
        fileSizeBytes: 1_000_000,
        dayDirectory: day,
      },
      db,
    );
  };
  const protect = (cam: Cam, startIso: string, types: string[], protectEventId: string = randomUUID(), seconds: number | null = 10) => {
    const startAt = new Date(startIso);
    return upsertProtectEvent(
      {
        protectEventId,
        protectDeviceId: CAMS[cam],
        cameraId: cameraId(cam),
        eventType: "smartDetectZone",
        startAt,
        endAt: seconds === null ? null : new Date(startAt.getTime() + seconds * 1000),
        smartDetectTypes: types,
        receivedAt: startAt,
      },
      db,
    );
  };

  // --- 25 Oct 2026 (DST end): local day = [24 Oct 22:00 UTC, 25 Oct 23:00 UTC) -----------------
  await clip("Driveway", "2026-10-24T22:00:00Z", "oct25-start"); // 00:00:00 CEST – inclusive
  // Neighbours across a day boundary are 1 s apart: different lengths keep them separate events
  // (otherwise the temporal fallback would rightly join them, docs/event-matching.md).
  await clip("Garden", "2026-10-24T21:59:59Z", "oct24-last", 5); // 23:59:59 on the 24th – excluded
  await clip("Doorbell", "2026-10-25T22:30:00Z", "oct25-late"); // 23:30 CET – 25-hour day
  await clip("Garage", "2026-10-25T23:00:00Z", "oct26-start"); // 26 Oct 00:00 CET – exclusive
  // Pending: Protect event without a clip (today 09:00 CEST)
  await protect("Driveway", "2026-10-25T07:00:00Z", ["package"], "pe-pending-paket", null);

  // --- multi-camera, matched: 23 Oct 12:00 CEST, Garden + Doorbell with person -----------------
  await clip("Garden", "2026-10-23T10:00:00Z", "multi", 40);
  await clip("Doorbell", "2026-10-23T10:00:01Z", "multi-k", 40);
  await protect("Garden", "2026-10-23T10:00:02Z", ["person"], "pe-multi-garden-77");
  await protect("Doorbell", "2026-10-23T10:00:03Z", ["person"]);

  // --- matched vehicle on "Garage 2", 22 Oct 08:00 CEST ---------------------------------------
  await clip("Garage 2", "2026-10-22T06:00:00Z", "terasse2-vehicle");
  await protect("Garage 2", "2026-10-22T06:00:02Z", ["vehicle"]);

  // --- identical start time on two cameras, 20 Oct 10:00 CEST (archive only) -------------------
  await clip("Driveway", "2026-10-20T08:00:00Z", "same-a");
  await clip("Garden", "2026-10-20T08:00:00Z", "same-b", 40); // other length: no temporal fallback

  // --- a file name with LIKE wildcards ---------------------------------------------------------
  await clip("Doorbell", "2026-10-19T08:00:00Z", "wild-100pct_x");

  // --- many Garden clips for pagination: 10–16 Oct, 12:00 CEST -----------------------------------
  for (let day = 10; day <= 16; day++) await clip("Garden", `2026-10-${day}T10:00:00Z`, `garden-${day}`);

  // --- 29 Mar 2026 (DST start): local day = [28 Mar 23:00 UTC, 29 Mar 22:00 UTC), 23 hours ------
  await clip("Doorbell", "2026-03-28T23:00:00Z", "mar29-start"); // 00:00 CET – inclusive
  await clip("Garden", "2026-03-29T21:59:00Z", "mar29-last"); // 23:59 CEST – included
  await clip("Driveway", "2026-03-29T22:00:00Z", "mar30-start"); // 30 Mar 00:00 CEST – excluded
  await clip("Garden", "2026-03-28T22:59:59Z", "mar28-last", 5); // 28 Mar 23:59:59 CET – excluded

  await reconcileArchive({ db });
}

let context: QueryContext;
const filters = (patch: Partial<ArchiveFilters> = {}): ArchiveFilters => ({ ...DEFAULT_ARCHIVE_FILTERS, ...patch });

/** All events for the filters via keyset pages of `pageSize`. */
async function allPages(patch: Partial<ArchiveFilters> = {}, pageSize = 3): Promise<EventCardModel[]> {
  const events: EventCardModel[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = await getArchivePage(filters(patch), cursor, context, pageSize);
    events.push(...page.events);
    if (!page.nextCursor) return events;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

/** Tags of the events in list order (clip file name tag; pending events: Protect event ID). */
async function tags(patch: Partial<ArchiveFilters> = {}, pageSize = 3): Promise<string[]> {
  return (await allPages(patch, pageSize)).map((event) => tagById.get(event.id)!);
}
let tagById: Map<string, string>;
let startById: Map<string, number>;

describe("archive search and period filters", () => {
  beforeAll(async () => {
    const { db, pool } = await createIsolatedDb();
    await buildFixture(db);
    context = queryContext({ db, now: NOW, timeZone: TZ });
    // Event ID → tag, via the clip file names (pending events: the Protect event ID).
    const { rows } = await pool.query<{ id: string; tag: string; start_at: Date }>(`
      select e.id, e.start_at, coalesce(min(substring(c.file_name from '\\[([a-z0-9_-]+)\\]')), min(p.protect_event_id)) as tag
      from archive_events e
      left join archive_event_clips lc on lc.archive_event_id = e.id
      left join archived_clips c on c.id = lc.archived_clip_id
      left join archive_event_protect_events lp on lp.archive_event_id = e.id
      left join protect_events p on p.id = lp.protect_event_id
      group by e.id`);
    tagById = new Map(rows.map((row) => [row.id, row.tag]));
    startById = new Map(rows.map((row) => [row.id, row.start_at.getTime()]));
  });

  describe("text search", () => {
    it("finds camera names case-insensitively", async () => {
      const driveway = await tags({ query: "Driveway" });
      expect(driveway.sort()).toEqual(["mar30-start", "oct25-start", "pe-pending-paket", "same-a"].sort());
      expect((await tags({ query: "driveWAY" })).sort()).toEqual(driveway.sort());
    });

    it("„Garden“ finds only events with a Garden clip or Protect event", async () => {
      const expected = ["oct24-last", "multi", "same-b", "mar29-last", "mar28-last", ...[10, 11, 12, 13, 14, 15, 16].map((day) => `garden-${day}`)];
      expect((await tags({ query: "Garden" })).sort()).toEqual(expected.sort());
    });

    it("finds only cameras that really exist: „Garage“ matches both Garage cameras, „Garagge“ nothing", async () => {
      expect((await tags({ query: "Garage" })).sort()).toEqual(["oct26-start", "terasse2-vehicle"]);
      expect(await tags({ query: "Garage 2" })).toEqual(["terasse2-vehicle"]);
      expect(await tags({ query: "Garagge" })).toEqual([]);
    });

    it("finds a multi-camera event via each of its cameras", async () => {
      expect(await tags({ query: "Garden" })).toContain("multi");
      expect(await tags({ query: "Doorbell" })).toContain("multi");
      const [multi] = await allPages({ query: "pe-multi-garden" });
      expect(multi.cameras.map((camera) => camera.name)).toEqual(["Doorbell", "Garden"]);
    });

    it("finds clip file names and Protect event IDs", async () => {
      expect(await tags({ query: "same-b" })).toEqual(["same-b"]);
      expect(await tags({ query: "pe-multi-garden-77" })).toEqual(["multi"]);
      expect(await tags({ query: "PE-PENDING" })).toEqual(["pe-pending-paket"]);
    });

    it("treats % and _ literally", async () => {
      expect(await tags({ query: "100pct_x" })).toEqual(["wild-100pct_x"]);
      expect(await tags({ query: "%" })).toEqual([]);
      expect(await tags({ query: "t_x" })).toEqual(["wild-100pct_x"]);
      expect(await tags({ query: "pct%x" })).toEqual([]);
    });

    it("finds detections by their German label as free text (in addition to the type filter)", async () => {
      expect(await tags({ query: "Person" })).toEqual(["multi"]);
      expect(await tags({ query: "fahrzeug" })).toEqual(["terasse2-vehicle"]);
      expect(await tags({ query: "Paket" })).toEqual(["pe-pending-paket"]);
      expect(await tags({ detection: "vehicle" })).toEqual(["terasse2-vehicle"]);
    });

    it("returns nothing for a text without matches, everything for an empty text", async () => {
      expect(await allPages({ query: "gibt-es-nicht" })).toEqual([]);
      expect((await allPages({ query: "" })).length).toBe(tagById.size);
    });
  });

  describe("periods", () => {
    it("today on the DST-end day: 25 hours, start inclusive, end exclusive", async () => {
      expect((await tags({ period: "today" })).sort()).toEqual(["oct25-late", "oct25-start", "pe-pending-paket"].sort());
    });

    it("7 days = today and the 6 previous calendar days", async () => {
      // 19–25 Oct: everything from 19 Oct 00:00 CEST on, without 26 Oct (start of tomorrow is not excluded for 7d, but nothing lies there except the future clip)
      const week = await tags({ period: "7d" });
      expect(week).toEqual(expect.arrayContaining(["oct25-start", "oct24-last", "multi", "terasse2-vehicle", "same-a", "same-b", "wild-100pct_x"]));
      expect(week.some((tag) => tag.startsWith("garden-"))).toBe(false); // 10–16 Oct
      expect(week).not.toContain("mar29-start");
    });

    it("30 days = today and the 29 previous calendar days", async () => {
      const month = await tags({ period: "30d" });
      expect(month.filter((tag) => tag.startsWith("garden-"))).toHaveLength(7);
      expect(month.some((tag) => tag.startsWith("mar"))).toBe(false);
    });

    it("custom range: whole local days, start inclusive, day after end exclusive", async () => {
      expect((await tags({ period: "custom", from: "2026-10-24", to: "2026-10-24" }))).toEqual(["oct24-last"]);
      expect((await tags({ period: "custom", from: "2026-10-25", to: "2026-10-25" })).sort()).toEqual(
        ["oct25-late", "oct25-start", "pe-pending-paket"].sort(),
      );
      expect((await tags({ period: "custom", from: "2026-10-20", to: "2026-10-20" })).sort()).toEqual(["same-a", "same-b"]);
    });

    it("custom range on the DST-start day (23 hours)", async () => {
      expect((await tags({ period: "custom", from: "2026-03-29", to: "2026-03-29" })).sort()).toEqual(["mar29-last", "mar29-start"]);
      expect(await tags({ period: "custom", from: "2026-03-28", to: "2026-03-28" })).toEqual(["mar28-last"]);
      expect(await tags({ period: "custom", from: "2026-03-30", to: "2026-03-30" })).toEqual(["mar30-start"]);
    });

    it("open custom ranges and start after end", async () => {
      expect(await tags({ period: "custom", to: "2026-03-28" })).toEqual(["mar28-last"]);
      expect((await tags({ period: "custom", from: "2026-10-25" })).sort()).toEqual(["oct25-late", "oct25-start", "oct26-start", "pe-pending-paket"].sort());
      expect(await allPages({ period: "custom", from: "2026-10-25", to: "2026-10-01" })).toEqual([]);
    });
  });

  describe("combinations and pagination", () => {
    it("period + camera, period + text, camera + text, everything together", async () => {
      const options = await getCameraFilterOptions(context);
      const doorbell = options.find((option) => option.label === "Doorbell")!.value;
      expect(await tags({ period: "today", cameraId: doorbell })).toEqual(["oct25-late"]);
      expect(await tags({ period: "7d", query: "garden" })).toEqual(expect.arrayContaining(["oct24-last", "multi", "same-b"]));
      expect(await tags({ period: "7d", query: "garden" })).toHaveLength(3);
      expect(await tags({ cameraId: doorbell, query: "garden" })).toEqual(["multi"]);
      expect(await tags({ period: "7d", cameraId: doorbell, detection: "person", query: "garden" })).toEqual(["multi"]);
      expect(await tags({ period: "today", detection: "package" })).toEqual(["pe-pending-paket"]);
    });

    it("pages filtered results without duplicates or gaps (search, period, camera)", async () => {
      const options = await getCameraFilterOptions(context);
      const garden = options.find((option) => option.label === "Garden")!.value;
      for (const patch of [{ query: "garden" }, { period: "30d" as const }, { cameraId: garden }, { period: "30d" as const, query: "garden" }]) {
        const paged = await allPages(patch, 2);
        const single = await allPages(patch, 500);
        expect(paged.map((e) => e.id), JSON.stringify(patch)).toEqual(single.map((e) => e.id));
        expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
        // start DESC, id DESC
        for (let i = 1; i < paged.length; i++) {
          const [a, b] = [paged[i - 1], paged[i]];
          const [startA, startB] = [startById.get(a.id)!, startById.get(b.id)!];
          const order = startA === startB ? a.id > b.id : startA > startB;
          expect(order, `${a.id} before ${b.id}`).toBe(true);
        }
      }
    });

    it("keeps both events with identical start times across a page boundary", async () => {
      const paged = await allPages({ period: "custom", from: "2026-10-20", to: "2026-10-20" }, 1);
      expect(paged).toHaveLength(2);
      expect(paged[0].id > paged[1].id).toBe(true);
    });

    it("a cursor from other filters cannot leak foreign results into a new filter", async () => {
      const first = await getArchivePage(filters({ query: "garden" }), null, context, 2);
      // The UI starts a new list for new filters; even a reused cursor only yields matching events.
      const next = await getArchivePage(filters({ query: "doorbell" }), first.nextCursor, context, 50);
      expect(next.events.every((event) => event.cameras.some((camera) => camera.name === "Doorbell"))).toBe(true);
    });
  });
});
