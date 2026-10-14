import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ARCHIVE_FILTERS, type ArchiveFilters } from "@/lib/archive-filters";
import type { EventCardModel } from "@/lib/view-models";
import type { Database } from "@/server/db/types";
import { reconcileArchive } from "@/server/matching/reconcile";
import { getArchivePage, getCameraFilterOptions, getDetectionTypeOptions, getEventDetail, hasArchiveEvents } from "@/server/queries/archive";
import { getCameras, getSystemStatus } from "@/server/queries/cameras-system";
import { queryContext, type QueryContext } from "@/server/queries/context";
import { getDashboard } from "@/server/queries/dashboard";
import { createArchivedClip } from "@/server/repositories/archived-clips";
import { completeScanRun, failScanRun, startScanRun } from "@/server/repositories/archive-scan-runs";
import { upsertCameras } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { createIsolatedDb } from "./helpers";

/** "Now" for all queries: 6 Oct 2026, 12:00 in Berlin. */
const NOW = new Date("2026-10-06T10:00:00Z");
const TZ = "Europe/Berlin";
/** Berlin wall-clock time `daysAgo` days before NOW (October 2026 = UTC+2). */
const berlin = (daysAgo: number, time: string) =>
  new Date(new Date(`2026-10-06T${time}+02:00`).getTime() - daysAgo * 86_400_000);

const CAMS = {
  Doorbell: { id: "660000000000000000000003", state: "online" },
  Driveway: { id: "660000000000000000000002", state: "online" },
  Garden: { id: "660000000000000000000001", state: "offline" },
  Garage: { id: "660000000000000000000004", state: "online" },
} as const;
type CamName = keyof typeof CAMS;

async function buildFixture(db: Database) {
  const cameras = await upsertCameras(
    Object.entries(CAMS).map(([name, cam]) => ({
      protectDeviceId: cam.id,
      name,
      state: cam.state,
      protectState: cam.state === "online" ? "CONNECTED" : "DISCONNECTED",
      smartDetectTypes: name === "Doorbell" ? ["person", "package", "face"] : ["person", "vehicle"],
      lastSeenAt: new Date("2026-10-01T10:00:00Z"),
    })),
    db,
  );
  const cameraId = (name: CamName) => cameras.find((c) => c.camera.protectDeviceId === CAMS[name].id)!.camera.id;

  const clip = (camera: string, start: Date, seconds: number, label: string, size: number | null = 1_000_000) => {
    const fileName = `${camera} ${label}.mp4`;
    return createArchivedClip(
      {
        cameraName: camera,
        startAt: start,
        endAt: new Date(start.getTime() + seconds * 1000),
        durationMs: seconds * 1000,
        filePath: `${start.toISOString().slice(0, 10)}/${fileName}`,
        fileName,
        fileSizeBytes: size,
        dayDirectory: start.toISOString().slice(0, 10),
      },
      db,
    );
  };
  const protect = (camera: CamName, types: string[], start: Date, seconds: number | null, protectEventId: string = randomUUID()) =>
    upsertProtectEvent(
      {
        protectEventId,
        protectDeviceId: CAMS[camera].id,
        cameraId: cameraId(camera),
        eventType: "smartDetectZone",
        startAt: start,
        endAt: seconds === null ? null : new Date(start.getTime() + seconds * 1000),
        smartDetectTypes: types,
        receivedAt: new Date(start.getTime() + 1000),
      },
      db,
    );

  // A: today 07:42 Garden person (matched)
  await clip("Garden", berlin(0, "07:42:00"), 30, "a");
  await protect("Garden", ["person"], berlin(0, "07:42:05"), 10);
  // B: today 07:31 Driveway vehicle + plate (matched)
  await clip("Driveway", berlin(0, "07:31:00"), 42, "b");
  await protect("Driveway", ["vehicle", "licensePlate"], berlin(0, "07:31:05"), 20);
  // C: yesterday 13:01 Doorbell + Driveway person (multi-camera, matched)
  await clip("Doorbell", berlin(1, "13:01:04"), 74, "c");
  await clip("Driveway", berlin(1, "13:01:05"), 73, "c");
  await protect("Doorbell", ["person"], berlin(1, "13:01:04"), 14);
  await protect("Driveway", ["person"], berlin(1, "13:01:05"), 14, "pe-driveway-1301-search-me");
  // D: yesterday 21:14 Doorbell, no metadata (archiveOnly), unknown size
  await clip("Doorbell", berlin(1, "21:14:02"), 63, "d", null);
  // E: today 09:00 Garage person, still ongoing, no clip (pendingClip)
  await protect("Garage", ["person"], berlin(0, "09:00:00"), null);
  // F: 3 days ago, very long file name (archiveOnly)
  await clip("Garage", berlin(3, "22:47:09"), 82, `f ${"x".repeat(120)} 100%_done`);
  // G: 40 days ago Garden (archiveOnly, outside 30 days)
  await clip("Garden", berlin(40, "10:00:00"), 30, "g");
  // H: 2 days ago Garden with an unknown detection type (matched)
  await clip("Garden", berlin(2, "18:22:07"), 34, "h");
  await protect("Garden", ["someFutureType"], berlin(2, "18:22:10"), 10);
  // I: 4 days ago Doorbell, Protect event without detection types (matched, but no detection)
  await clip("Doorbell", berlin(4, "11:00:00"), 20, "i");
  await protect("Doorbell", [], berlin(4, "11:00:02"), 10);
  // J1/J2: 5 days ago, identical start time on two cameras (archiveOnly; cursor tie-break)
  await clip("Doorbell", berlin(5, "08:00:00"), 10, "j1");
  await clip("Garage", berlin(5, "08:00:00"), 30, "j2"); // other length: no temporal fallback

  await reconcileArchive({ db });

  // Scan history: a completed scan, then a failed one.
  const completed = await startScanRun("/archive", db);
  await completeScanRun(completed, { dayDirectoryCount: 8, discoveredCount: 12, updatedCount: 0, unchangedCount: 0, failedCount: 1, warningCount: 0 }, db);
  const failed = await startScanRun("/archive", db);
  await failScanRun(failed.id, { dayDirectoryCount: 0, discoveredCount: 0, updatedCount: 0, unchangedCount: 0, failedCount: 0, warningCount: 0 }, "ARCHIVE_ROOT “/archive” does not exist (is the NAS mounted?).", db);
}

let context: QueryContext;
const filters = (patch: Partial<ArchiveFilters> = {}): ArchiveFilters => ({ ...DEFAULT_ARCHIVE_FILTERS, ...patch });

/** All events for the filters, following cursors with a small page size. */
async function allPages(patch: Partial<ArchiveFilters> = {}, pageSize = 2): Promise<EventCardModel[]> {
  const events: EventCardModel[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await getArchivePage(filters(patch), cursor, context, pageSize);
    events.push(...page.events);
    if (!page.nextCursor) return events;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

const labels = (events: EventCardModel[]) => events.map((e) => `${e.whenLabel} ${e.cameras.map((c) => c.name).join("+")}`);

describe("UI queries", () => {
  beforeAll(async () => {
    const { db } = await createIsolatedDb();
    await buildFixture(db);
    context = queryContext({ db, now: NOW, timeZone: TZ });
  });

  describe("archive", () => {
    it("lists all events newest first with stable keyset pages (incl. equal start times)", async () => {
      const paged = await allPages({}, 2);
      const single = (await getArchivePage(filters(), null, context, 100)).events;
      expect(paged.map((e) => e.id)).toEqual(single.map((e) => e.id));
      expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
      const ordered = labels(paged);
      expect(ordered.slice(0, 8)).toEqual([
        "09:00 Garage",
        "07:42 Garden",
        "07:31 Driveway",
        "Gestern, 21:14 Doorbell",
        "Gestern, 13:01 Doorbell+Driveway",
        "04.10., 18:22 Garden",
        "03.10., 22:47 Garage",
        "02.10., 11:00 Doorbell",
      ]);
      // Same start time: both present, order decided by the ID tie-breaker (id DESC).
      expect(ordered.slice(8, 10).sort()).toEqual(["01.10., 08:00 Doorbell", "01.10., 08:00 Garage"]);
      expect(paged[8].id > paged[9].id).toBe(true);
      expect(ordered[10]).toBe("27.08., 10:00 Garden");
      // Strictly descending by start.
      expect(paged.map((e) => `${e.dayKey} ${e.timeLabel}`)).toEqual(
        [...paged.map((e) => `${e.dayKey} ${e.timeLabel}`)].sort().reverse(),
      );
    });

    it("maps statuses, cameras and counts onto cards", async () => {
      const events = await allPages();
      const multi = events.find((e) => e.cameras.length === 2)!;
      expect(multi).toMatchObject({
        status: "matched",
        detectionTypes: ["person"],
        cameras: [expect.objectContaining({ name: "Doorbell" }), expect.objectContaining({ name: "Driveway" })],
        clipCount: 2,
        protectEventCount: 2,
        durationSeconds: 74,
        dayLabel: "Gestern",
      });
      const pending = events.find((e) => e.status === "pendingClip")!;
      expect(pending).toMatchObject({ timeLabel: "09:00", durationSeconds: null, clipCount: 0, protectEventCount: 1 });
      expect(events.filter((e) => e.status === "archiveOnly").map((e) => e.detectionTypes)).toEqual([[], [], [], [], []]);
      expect(events.find((e) => e.detectionTypes.includes("someFutureType"))?.status).toBe("matched");
    });

    it("filters by period in the app time zone", async () => {
      expect(labels(await allPages({ period: "today" }))).toEqual(["09:00 Garage", "07:42 Garden", "07:31 Driveway"]);
      expect(await allPages({ period: "7d" })).toHaveLength(10);
      expect(await allPages({ period: "30d" })).toHaveLength(10);
      expect(labels(await allPages({ period: "custom", from: "2026-10-05", to: "2026-10-05" }))).toEqual([
        "Gestern, 21:14 Doorbell",
        "Gestern, 13:01 Doorbell+Driveway",
      ]);
    });

    it("filters by camera, including multi-camera events", async () => {
      const driveway = (await getCameraFilterOptions(context)).find((option) => option.label === "Driveway")!.value;
      expect(labels(await allPages({ cameraId: driveway }))).toEqual(["07:31 Driveway", "Gestern, 13:01 Doorbell+Driveway"]);
    });

    it("filters by detection type (also unknown ones), without detection and with detection", async () => {
      expect(labels(await allPages({ detection: "person" }))).toEqual(["09:00 Garage", "07:42 Garden", "Gestern, 13:01 Doorbell+Driveway"]);
      expect(labels(await allPages({ detection: "licensePlate" }))).toEqual(["07:31 Driveway"]);
      expect(labels(await allPages({ detection: "someFutureType" }))).toEqual(["04.10., 18:22 Garden"]);
      // "With detection" means a Protect event with at least one type – event I (matched, no types) is excluded.
      const detected = await allPages({ onlyDetected: true });
      expect(detected).toHaveLength(5);
      expect(detected.every((e) => e.detectionTypes.length > 0)).toBe(true);
      const none = await allPages({ detection: "none" });
      expect(none).toHaveLength(6);
      expect(none.some((e) => e.status === "matched" && e.whenLabel === "02.10., 11:00")).toBe(true);
    });

    it("searches camera names, file names and Protect event IDs", async () => {
      expect(await allPages({ query: "doorbell" })).toHaveLength(4);
      expect(labels(await allPages({ query: "f xxx" }))).toEqual(["03.10., 22:47 Garage"]);
      expect(labels(await allPages({ query: "pe-driveway-1301" }))).toEqual(["Gestern, 13:01 Doorbell+Driveway"]);
      // LIKE wildcards are literal.
      expect(labels(await allPages({ query: "100%_done" }))).toEqual(["03.10., 22:47 Garage"]);
      // "%" is a literal character, not "match everything": only the file that contains one.
      expect(labels(await allPages({ query: "%" }))).toEqual(["03.10., 22:47 Garage"]);
      expect(await allPages({ query: "_" })).toHaveLength(1);
      expect(await allPages({ query: "nichts-passt" })).toEqual([]);
    });

    it("combines filters", async () => {
      expect(labels(await allPages({ period: "today", detection: "person", query: "garden" }))).toEqual(["07:42 Garden"]);
    });

    it("offers the detection types that occur", async () => {
      expect(await getDetectionTypeOptions(context)).toEqual(["person", "licensePlate", "someFutureType", "vehicle"]);
    });
  });

  describe("event detail", () => {
    it("loads a multi-camera event with all clips and Protect events", async () => {
      const multi = (await allPages()).find((e) => e.cameras.length === 2)!;
      const detail = await getEventDetail(multi.id, context);
      expect(detail).toMatchObject({
        startLabel: "05.10.2026, 13:01:04",
        endLabel: "05.10.2026, 13:02:18",
        status: "matched",
      });
      expect(detail!.clips.map((c) => [c.cameraName, c.startLabel, c.endLabel, c.durationSeconds, c.directory])).toEqual([
        ["Doorbell", "13:01:04", "13:02:18", 74, "2026-10-05/"],
        ["Driveway", "13:01:05", "13:02:18", 73, "2026-10-05/"],
      ]);
      expect(detail!.protectEvents.map((p) => [p.cameraName, p.detectionTypes, p.startLabel, p.endLabel])).toEqual([
        ["Doorbell", ["person"], "13:01:04", "13:01:18"],
        ["Driveway", ["person"], "13:01:05", "13:01:19"],
      ]);
    });

    it("returns nothing for unknown or malformed IDs", async () => {
      expect(await getEventDetail(randomUUID(), context)).toBeUndefined();
      expect(await getEventDetail("evt-20261006-074213", context)).toBeUndefined();
    });
  });

  describe("dashboard", () => {
    it("shows real counts, archive size and the newest detection", async () => {
      const dashboard = await getDashboard(context);
      expect(dashboard).toMatchObject({
        isEmpty: false,
        eventsToday: 3,
        clipsTotal: 11,
        archiveSizeBytes: 10 * 1_000_000, // one clip has no size
        camerasTotal: 4,
        camerasOnline: 3,
        lastScanFailed: true,
      });
      expect(dashboard.latestDetection).toMatchObject({
        detectionTypes: ["person"],
        cameras: [expect.objectContaining({ name: "Garage" })],
        timeLabel: "09:00",
        relativeLabel: "vor 3 Stunden",
      });
      expect(dashboard.recentEvents.map((e) => e.timeLabel)).toEqual(["09:00", "07:42", "07:31", "21:14", "13:01"]);
      expect(dashboard.detections).toEqual([
        { type: "person", count: 3 },
        { type: "licensePlate", count: 1 },
        { type: "someFutureType", count: 1 },
        { type: "vehicle", count: 1 },
      ]);
    });
  });

  describe("cameras and system", () => {
    it("lists cameras online first, with states and statistics", async () => {
      const cameras = await getCameras(context);
      expect(cameras.map((c) => [c.name, c.online, c.protectStateLabel])).toEqual([
        ["Doorbell", true, "Connected"],
        ["Driveway", true, "Connected"],
        ["Garage", true, "Connected"],
        ["Garden", false, "Disconnected"],
      ]);
      expect(cameras.find((c) => c.name === "Doorbell")).toMatchObject({
        smartDetectTypes: ["person", "package", "face"],
        clipCount: 4,
        clipsToday: 0,
        protectDeviceId: CAMS.Doorbell.id,
      });
      expect(cameras.find((c) => c.name === "Garden")).toMatchObject({ clipsToday: 1, lastClipLabel: "vor 4 Stunden" });
    });

    it("reports only measured system facts, incl. the last failed and last completed scan", async () => {
      const system = await getSystemStatus(context);
      expect(system).toMatchObject({
        clipsTotal: 11,
        eventsTotal: 11,
        eventsByStatus: { matched: 5, archiveOnly: 5, pendingClip: 1 },
        camerasTotal: 4,
        camerasOnline: 3,
        protectEventsTotal: 7,
        timeZone: TZ,
      });
      expect(system.lastScan).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("NAS mounted") });
      expect(system.lastCompletedScan).toMatchObject({ status: "completed", discovered: 12, failed: 1, filesFound: 13 });
      expect(system.databaseVersion).toMatch(/^18\./);
    });
  });
});

describe("UI queries on an empty database", () => {
  it("reports a fresh installation instead of failing", async () => {
    const { db } = await createIsolatedDb();
    const empty = queryContext({ db, now: NOW, timeZone: TZ });
    expect(await hasArchiveEvents(empty)).toBe(false);
    expect(await getDashboard(empty)).toMatchObject({ isEmpty: true, latestDetection: null, lastScanLabel: null, recentEvents: [], detections: [] });
    expect(await getArchivePage(DEFAULT_ARCHIVE_FILTERS, null, empty)).toEqual({ events: [], nextCursor: null });
    expect(await getCameras(empty)).toEqual([]);
    expect(await getSystemStatus(empty)).toMatchObject({ lastScan: null, eventsTotal: 0, lastProtectEventLabel: null });
  });
});
