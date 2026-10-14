import { describe, expect, it } from "vitest";

import {
  archiveHref,
  archiveReturnHref,
  DEFAULT_ARCHIVE_FILTERS,
  eventHref,
  parseArchiveFilters,
  serializeArchiveFilters,
} from "@/lib/archive-filters";
import { createDateFormat } from "@/lib/date-format";
import { eventTitle } from "@/lib/event-title";
import { formatBytes, formatDuration, formatRelative } from "@/lib/format";
import { detectionLabel, METADATA_STATUS_LABELS } from "@/lib/labels";
import { addDays, dayKeyInZone, isDayKey, startOfDayInZone } from "@/lib/time-zone";
import { resolveAppTimeZone } from "@/server/app-time-zone";
import { decodeCursor, encodeCursor, periodRange } from "@/server/queries/archive";
import {
  clipLabels,
  eventCameras,
  eventDetectionTypes,
  eventGrouping,
  eventPreviews,
  toEventCardModel,
  toEventDetailModel,
} from "@/server/view-models/archive-events";
import { humanizeProtectState, sortCameras } from "@/server/view-models/cameras-system";

const BERLIN = "Europe/Berlin";

describe("time zone arithmetic", () => {
  it("computes local midnight as an instant, including both DST changes", () => {
    expect(startOfDayInZone("2026-10-06", BERLIN).toISOString()).toBe("2026-10-05T22:00:00.000Z");
    expect(startOfDayInZone("2026-01-15", BERLIN).toISOString()).toBe("2026-01-14T23:00:00.000Z");
    // 29 March 2026: CET → CEST; 25 October 2026: CEST → CET.
    expect(startOfDayInZone("2026-03-29", BERLIN).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfDayInZone("2026-03-30", BERLIN).toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(startOfDayInZone("2026-10-25", BERLIN).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfDayInZone("2026-10-26", BERLIN).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(startOfDayInZone("2026-10-06", "America/New_York").toISOString()).toBe("2026-10-06T04:00:00.000Z");
  });

  it("finds the calendar day of an instant in the zone", () => {
    expect(dayKeyInZone(new Date("2026-10-05T22:30:00Z"), BERLIN)).toBe("2026-10-06");
    expect(dayKeyInZone(new Date("2026-10-05T22:30:00Z"), "UTC")).toBe("2026-10-05");
  });

  it("adds days across months and years and validates day keys", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isDayKey("2026-02-28")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-2-3")).toBe(false);
  });

  it("validates APP_TIME_ZONE", () => {
    expect(resolveAppTimeZone(undefined)).toBe("Europe/Berlin");
    expect(resolveAppTimeZone(" America/New_York ")).toBe("America/New_York");
    expect(() => resolveAppTimeZone("Mars/Base")).toThrow(/APP_TIME_ZONE/);
  });
});

describe("date format", () => {
  const format = createDateFormat(BERLIN);
  const now = new Date("2026-10-06T10:00:00Z"); // 12:00 in Berlin

  it("labels days relative to now in the app time zone", () => {
    expect(format.dayLabel(new Date("2026-10-05T22:30:00Z"), now)).toBe("Heute"); // 00:30 local
    expect(format.dayLabel(new Date("2026-10-05T21:30:00Z"), now)).toBe("Gestern");
    expect(format.dayLabel(new Date("2026-10-04T10:00:00Z"), now)).toBe("Sonntag, 4. Oktober");
    expect(format.dayLabel(new Date("2025-10-04T10:00:00Z"), now)).toBe("Samstag, 4. Oktober 2025");
  });

  it("formats times in the app time zone, not the process time zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      expect(format.time(new Date("2026-10-06T05:42:13Z"))).toBe("07:42");
      expect(format.dateTime(new Date("2026-10-06T05:42:13Z"))).toBe("06.10.2026, 07:42:13");
      expect(format.eventTime(new Date("2026-10-05T19:14:00Z"), now)).toBe("Gestern, 21:14");
      expect(format.eventTime(new Date("2026-10-02T14:40:00Z"), now)).toBe("02.10., 16:40");
    } finally {
      process.env.TZ = original;
    }
  });

  it("formats durations, sizes and relative times", () => {
    expect(formatDuration(18)).toBe("18 Sek.");
    expect(formatDuration(63)).toBe("1:03 Min.");
    expect(formatDuration(3725)).toBe("1:02:05 Std.");
    expect(formatBytes(1.82e12)).toBe("1,82 TB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatRelative(new Date("2026-10-06T09:58:00Z"), now)).toBe("vor 2 Minuten");
  });
});

describe("archive URL state", () => {
  it("parses filters and ignores invalid or hostile values", () => {
    expect(
      parseArchiveFilters(
        new URLSearchParams({
          q: "  Garden  ",
          period: "custom",
          from: "2026-10-01",
          to: "2026-02-30",
          camera: "not-a-uuid",
          type: "person'; drop table",
          detected: "1",
        }),
      ),
    ).toEqual({ ...DEFAULT_ARCHIVE_FILTERS, query: "Garden", period: "custom", from: "2026-10-01", onlyDetected: true });
    expect(parseArchiveFilters({ type: "someFutureType", camera: "66F2A1C0-012E-4B03-E800-000000000101" })).toMatchObject({
      detection: "someFutureType",
      cameraId: "66f2a1c0-012e-4b03-e800-000000000101",
    });
    expect(parseArchiveFilters({ period: "forever", q: "x".repeat(500) }).query).toHaveLength(100);
  });

  it("serializes only non-default values", () => {
    expect(serializeArchiveFilters(DEFAULT_ARCHIVE_FILTERS).toString()).toBe("");
    expect(archiveHref({ ...DEFAULT_ARCHIVE_FILTERS, period: "7d", detection: "person" })).toBe("/archive?period=7d&type=person");
  });

  it("builds back links that can only point to the archive", () => {
    expect(archiveReturnHref("period=7d&type=person")).toBe("/archive?period=7d&type=person");
    for (const hostile of ["//evil.example", "https://evil.example/archive", "javascript:alert(1)", "?next=https://evil.example"]) {
      expect(archiveReturnHref(hostile)).toBe("/archive");
    }
    expect(archiveReturnHref(undefined)).toBe("/archive");
    expect(eventHref("e1", { ...DEFAULT_ARCHIVE_FILTERS, period: "today" })).toBe("/archive/e1?from=period%3Dtoday");
    expect(eventHref("e1")).toBe("/archive/e1");
  });

  it("maps periods to day boundaries in the app time zone", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    expect(periodRange({ ...DEFAULT_ARCHIVE_FILTERS, period: "today" }, now, BERLIN)).toEqual({
      start: new Date("2026-10-05T22:00:00Z"),
      end: new Date("2026-10-06T22:00:00Z"),
    });
    expect(periodRange({ ...DEFAULT_ARCHIVE_FILTERS, period: "7d" }, now, BERLIN)).toEqual({ start: new Date("2026-09-29T22:00:00Z") });
    expect(periodRange({ ...DEFAULT_ARCHIVE_FILTERS, period: "custom", from: "2026-10-01", to: "2026-10-02" }, now, BERLIN)).toEqual({
      start: new Date("2026-09-30T22:00:00Z"),
      end: new Date("2026-10-02T22:00:00Z"),
    });
    expect(periodRange(DEFAULT_ARCHIVE_FILTERS, now, BERLIN)).toEqual({});
  });
});

describe("cursor", () => {
  it("round-trips and rejects anything else", () => {
    const cursor = { startAt: "2026-01-15 11:00:13.123+01", id: "22222222-2222-4222-8222-222222222222" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const bad of [
      "",
      "garbage",
      Buffer.from(JSON.stringify(["2026-10-06 07:42:13+02", "x"])).toString("base64url"),
      Buffer.from(JSON.stringify(["now()); drop table x; --", cursor.id])).toString("base64url"),
      Buffer.from(JSON.stringify({ a: 1 })).toString("base64url"),
    ]) {
      expect(decodeCursor(bad)).toBeUndefined();
    }
  });
});

describe("labels and view models", () => {
  it("labels known and unknown detection types", () => {
    expect(detectionLabel("licensePlate")).toBe("Kennzeichen");
    expect(detectionLabel("someFutureType")).toBe("Some future type");
    expect(detectionLabel("alrmSmoke")).toBe("Alrm smoke");
    expect(METADATA_STATUS_LABELS).toEqual({ matched: "Erkennung", archiveOnly: "Archivclip", pendingClip: "Aufnahme ausstehend" });
    expect(eventTitle({ detectionTypes: ["vehicle"], status: "matched" })).toBe("Fahrzeug erkannt");
    expect(eventTitle({ detectionTypes: [], status: "pendingClip" })).toBe("Aufnahme ausstehend");
    expect(humanizeProtectState("FIRMWARE_UPDATING")).toBe("Firmware updating");
  });

  const clip = (cameraId: string | null, cameraName: string, primaryGroupId = "g") => ({
    eventId: "e",
    primaryGroupId,
    clipId: `${cameraName}-clip`,
    cameraId,
    cameraName,
    filePath: `2026-10-06/${cameraName}.mp4`,
    fileSizeBytes: null,
    fileModifiedAt: null,
    startAt: new Date("2026-10-06T05:00:00Z"),
    endAt: new Date("2026-10-06T05:01:00Z"),
    durationMs: 60_000,
  });
  const protect = (cameraId: string | null, cameraName: string | null, types: string[], start: string, primaryGroupId = "g") => ({
    eventId: "e",
    primaryGroupId,
    protectEventId: `${cameraName}-${start}`,
    eventType: "smartDetectZone",
    cameraId,
    cameraName,
    smartDetectTypes: types,
    startAt: new Date(start),
    endAt: null,
  });

  it("lists each camera once and keeps unresolved clip cameras by name", () => {
    expect(
      eventCameras(
        [clip("k", "Doorbell"), clip(null, "Carport"), clip(null, "Carport")],
        [protect("k", "Doorbell", ["person"], "2026-10-06T05:00:00Z"), protect("e", "Driveway", ["person"], "2026-10-06T05:00:01Z")],
      ),
    ).toEqual([
      { key: "name:Carport", name: "Carport" },
      { key: "k", name: "Doorbell" },
      { key: "e", name: "Driveway" },
    ]);
  });

  it("collects detection types in first-seen order and builds cards", () => {
    const protectEvents = [
      protect("k", "Doorbell", ["vehicle", "person"], "2026-10-06T05:00:05Z"),
      protect("e", "Driveway", ["person", "someFutureType"], "2026-10-06T05:00:01Z"),
    ];
    expect(eventDetectionTypes(protectEvents)).toEqual(["person", "someFutureType", "vehicle"]);
    const card = toEventCardModel(
      { id: "e", startAt: new Date("2026-10-06T05:00:00Z"), endAt: null, status: "pendingClip" },
      [],
      protectEvents,
      { format: createDateFormat(BERLIN), now: new Date("2026-10-06T10:00:00Z") },
    );
    expect(card).toMatchObject({ timeLabel: "07:00", dayLabel: "Heute", durationSeconds: null, clipCount: 0, protectEventCount: 2 });
  });

  it("tells metadata and temporal grouping apart, independent of the status", () => {
    const at = "2026-10-06T05:00:00Z";
    // One camera: no grouping hint at all.
    expect(eventGrouping([clip("k", "Doorbell")], [])).toEqual({ kind: null, parts: [] });
    // Two cameras in one primary group (Protect detections).
    expect(
      eventGrouping([clip("k", "Doorbell"), clip("e", "Driveway")], [protect("k", "Doorbell", ["person"], at), protect("e", "Driveway", ["person"], at)]),
    ).toEqual({ kind: "metadata", parts: [{ key: "g", cameras: ["Doorbell", "Driveway"], confirmed: true }] });
    // Historic clips joined by time: two groups, none confirmed by Protect.
    expect(eventGrouping([clip("k", "Doorbell", "g1"), clip("e", "Driveway", "g2")], [])).toMatchObject({
      kind: "temporal",
      parts: [
        { cameras: ["Doorbell"], confirmed: false },
        { cameras: ["Driveway"], confirmed: false },
      ],
    });
    // Mixed: Driveway confirmed by Protect, Doorbell only added by time.
    const mixed = eventGrouping(
      [clip("e", "Driveway", "g1"), clip("k", "Doorbell", "g2")],
      [protect("e", "Driveway", ["person"], at, "g1")],
    );
    expect(mixed.kind).toBe("temporal");
    expect(mixed.parts.map((part) => [part.cameras, part.confirmed])).toEqual([
      [["Driveway"], true],
      [["Doorbell"], false],
    ]);
    const card = toEventCardModel(
      { id: "e", startAt: new Date(at), endAt: null, status: "archiveOnly" },
      [clip("k", "Doorbell", "g1"), clip("e", "Driveway", "g2")],
      [],
      { format: createDateFormat(BERLIN), now: new Date("2026-10-06T10:00:00Z") },
    );
    expect(card).toMatchObject({ status: "archiveOnly", grouping: "temporal" });
  });

  it("sorts cameras online first, then by name", () => {
    expect(
      sortCameras([
        { online: false, name: "Front Door" },
        { online: true, name: "Garage" },
        { online: true, name: "Driveway" },
      ]).map((camera) => camera.name),
    ).toEqual(["Driveway", "Garage", "Front Door"]);
  });
});

describe("media in view models", () => {
  const format = createDateFormat(BERLIN);
  const clipAt = (cameraId: string | null, cameraName: string, start: string, clipId = `${cameraName}-${start}`) => ({
    eventId: "e",
    primaryGroupId: "g",
    clipId,
    cameraId,
    cameraName,
    filePath: `2026-03-29/${cameraName} ${start}.mp4`,
    fileSizeBytes: 2_000_000,
    fileModifiedAt: new Date("2026-03-29T11:05:00Z"),
    startAt: new Date(start),
    endAt: new Date(new Date(start).getTime() + 30_000),
    durationMs: 30_000,
  });

  it("previews the earliest clip, or one per camera for exactly two cameras", () => {
    const doorbell = clipAt("k", "Doorbell", "2026-03-29T11:01:04Z");
    const driveway = clipAt("e", "Driveway", "2026-03-29T11:01:05Z");
    const driveway2 = clipAt("e", "Driveway", "2026-03-29T11:00:30Z");
    const garden = clipAt(null, "Garden", "2026-03-29T11:02:00Z");

    expect(eventPreviews([])).toEqual([]);
    expect(eventPreviews([driveway]).map((p) => p.clipId)).toEqual([driveway.clipId]);
    // Two cameras: the earliest clip of each, earliest camera first.
    expect(eventPreviews([driveway, doorbell, driveway2]).map((p) => p.clipId)).toEqual([driveway2.clipId, doorbell.clipId]);
    // Three cameras: just the earliest clip.
    expect(eventPreviews([driveway, doorbell, garden]).map((p) => p.clipId)).toEqual([doorbell.clipId]);
    // Two clips of one camera: one preview.
    expect(eventPreviews([driveway, driveway2])).toHaveLength(1);

    const [preview] = eventPreviews([driveway]);
    expect(preview).toEqual({
      clipId: driveway.clipId,
      cameraName: "Driveway",
      thumbnailUrl: `/api/clips/${encodeURIComponent(driveway.clipId)}/thumbnail?v=${new Date("2026-03-29T11:05:00Z").getTime().toString(36)}-${(2_000_000).toString(36)}`,
    });
  });

  it("labels clips uniquely within an event", () => {
    expect(clipLabels([clipAt("k", "Doorbell", "2026-03-29T11:01:04Z"), clipAt("e", "Driveway", "2026-03-29T11:01:05Z")], format)).toEqual([
      "Doorbell",
      "Driveway",
    ]);
    expect(
      clipLabels(
        [
          clipAt("k", "Doorbell", "2026-03-29T11:01:04Z"),
          clipAt("k", "Doorbell", "2026-03-29T11:02:30Z"),
          clipAt("e", "Driveway", "2026-03-29T11:01:05Z"),
        ],
        format,
      ),
    ).toEqual(["Doorbell · 13:01", "Doorbell · 13:02", "Driveway"]);
    // Same minute: with seconds; same second: numbered.
    expect(clipLabels([clipAt("k", "Doorbell", "2026-03-29T11:01:04Z"), clipAt("k", "Doorbell", "2026-03-29T11:01:40Z")], format)).toEqual([
      "Doorbell · 13:01:04",
      "Doorbell · 13:01:40",
    ]);
    expect(
      clipLabels([clipAt("k", "Doorbell", "2026-03-29T11:01:04Z", "a"), clipAt("k", "Doorbell", "2026-03-29T11:01:04Z", "b")], format),
    ).toEqual(["Doorbell · 13:01:04 (1)", "Doorbell · 13:01:04 (2)"]);
  });

  it("gives every clip of the detail a video URL, a thumbnail URL and no absolute path", () => {
    const detail = toEventDetailModel(
      { id: "e", startAt: new Date("2026-03-29T11:01:04Z"), endAt: new Date("2026-03-29T11:02:18Z"), status: "matched" },
      [clipAt("e", "Driveway", "2026-03-29T11:01:05Z"), clipAt("k", "Doorbell", "2026-03-29T11:01:04Z")],
      [],
      { format, now: new Date("2026-10-06T10:00:00Z") },
    );
    expect(detail.clips.map((clip) => clip.label)).toEqual(["Doorbell", "Driveway"]);
    for (const clip of detail.clips) {
      expect(clip.videoUrl).toBe(`/api/clips/${encodeURIComponent(clip.id)}/video`);
      expect(clip.thumbnailUrl).toMatch(/^\/api\/clips\/.+\/thumbnail\?v=/);
    }
    expect(JSON.stringify(detail)).not.toMatch(/"\/(archive|volume1|tmp)/);
  });
});

