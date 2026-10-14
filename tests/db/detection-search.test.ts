import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ARCHIVE_FILTERS, type ArchiveFilters } from "@/lib/archive-filters";
import type { Locale } from "@/i18n/core";
import { reconcileArchive } from "@/server/matching/reconcile";
import { getArchivePage } from "@/server/queries/archive";
import { queryContext, type QueryContext } from "@/server/queries/context";
import { createArchivedClip } from "@/server/repositories/archived-clips";
import { upsertCameras } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { createIsolatedDb } from "./helpers";

const ALIASES = ["Licence plate", "License plate", "Kennzeichen", "licensePlate", "  LiCEnCe\t plate  "];
let context: QueryContext;
let drivewayId: string;
let expected: string[];
const filters = (patch: Partial<ArchiveFilters>) => ({ ...DEFAULT_ARCHIVE_FILTERS, ...patch });

async function ids(patch: Partial<ArchiveFilters>, locale: Locale = "en", size = 1) {
  const result: string[] = [];
  let cursor: string | null = null;
  const localized = queryContext({ db: context.db, now: context.now, timeZone: context.timeZone, locale });
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await getArchivePage(filters(patch), cursor, localized, size);
    result.push(...page.events.map((event) => event.id));
    if (!page.nextCursor) return result;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("locale-independent detection search against PostgreSQL", () => {
  beforeAll(async () => {
    const { db } = await createIsolatedDb();
    context = queryContext({ db, now: new Date("2026-01-16T12:00:00Z"), timeZone: "Europe/Berlin" });
    const cameras = await upsertCameras([
      { protectDeviceId: "66000000000000000000000a", name: "Driveway", state: "online", smartDetectTypes: ["licensePlate", "vehicle"] },
      { protectDeviceId: "66000000000000000000000b", name: "Garden", state: "online", smartDetectTypes: ["licensePlate"] },
    ], db);
    drivewayId = cameras[0].camera.id;
    const events = [
      [0, "2026-01-15T08:00:00Z", ["licensePlate", "vehicle"]],
      [0, "2026-01-15T09:00:00Z", ["licensePlate"]],
      [1, "2026-01-14T10:00:00Z", ["licensePlate"]],
      [0, "2026-01-15T16:00:00Z", []],
    ] as const;
    for (const [index, [cameraIndex, instant, types]] of events.entries()) {
      const camera = cameras[cameraIndex].camera;
      const startAt = new Date(instant);
      const endAt = new Date(startAt.getTime() + 10_000);
      const fileName = `${camera.name} [ordinary-${index}].mp4`;
      const dayDirectory = startAt.toISOString().slice(0, 10);
      await createArchivedClip({
        cameraId: camera.id, cameraName: camera.name, startAt, endAt, durationMs: 10_000,
        filePath: `${dayDirectory}/${fileName}`, fileName, dayDirectory, fileSizeBytes: 100,
      }, db);
      if (types.length) await upsertProtectEvent({
        protectEventId: `synthetic-search-event-${index}`, protectDeviceId: camera.protectDeviceId,
        cameraId: camera.id, eventType: "smartDetectZone", startAt, endAt,
        smartDetectTypes: [...types], receivedAt: startAt,
      }, db);
    }
    await reconcileArchive({ db });
    expected = await ids({ detection: "licensePlate" });
    expect(expected).toHaveLength(3);
  });

  it.each(ALIASES)("finds actual plate detections using %j in both locales and across pages", async (query) => {
    for (const locale of ["de", "en"] as const) {
      expect(await ids({ query }, locale)).toEqual(expected);
      expect(await ids({ query }, locale, 50)).toEqual(expected);
    }
  });

  it("retains camera, date and multi-type conditions when switching between equivalent aliases", async () => {
    const patch = { cameraId: drivewayId, period: "custom" as const, from: "2026-01-15", to: "2026-01-15" };
    const combined = await ids({ ...patch, detection: "licensePlate" });
    expect(combined).toHaveLength(2);
    for (const query of ALIASES) {
      for (const locale of ["de", "en"] as const) {
        expect(await ids({ ...patch, query }, locale)).toEqual(combined);
        expect(await ids({ ...patch, query, detection: "vehicle" }, locale)).toHaveLength(1);
        expect(await ids({ ...patch, query, detection: "none" }, locale)).toEqual([]);
      }
    }
    expect(await ids({ query: "Licence plate", period: "custom", from: "2026-01-16", to: "2026-01-16" })).toEqual([]);
  });

  it("preserves ordinary filename/camera search, unknown text, and literal SQL wildcards", async () => {
    expect(await ids({ query: "ordinary-3" })).toHaveLength(1);
    expect(await ids({ query: "Driveway" })).toHaveLength(3);
    expect(await ids({ query: "no-such-synthetic-event" })).toEqual([]);
    expect(await ids({ query: "Licence plate%' OR true --" })).toEqual([]);
    expect(await ids({ query: "%" })).toEqual([]);
  });
});
