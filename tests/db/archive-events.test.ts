import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { archiveEventClips, archiveEventProtectEvents } from "@/server/db/schema";
import { createArchivedClip } from "@/server/repositories/archived-clips";
import {
  attachClipToArchiveEvent,
  attachProtectEventToArchiveEvent,
  createArchiveEvent,
  findArchiveEventById,
} from "@/server/repositories/archive-events";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { clipInput, connectTestDb, expectDbError, PgErrorCode, uniqueProtectId } from "./helpers";

const { db } = connectTestDb();

/** The 13:01 example: one person, recorded by Driveway and Doorbell, reported by both. */
async function multiCameraFixture() {
  const event = await createArchiveEvent(
    {
      startAt: new Date("2026-03-29T13:01:04+02:00"),
      endAt: new Date("2026-03-29T13:02:18+02:00"),
      metadataStatus: "matched",
    },
    db,
  );
  const driveway = await createArchivedClip(
    clipInput({ cameraName: "Driveway", startAt: new Date("2026-03-29T13:01:05+02:00") }),
    db,
  );
  const doorbell = await createArchivedClip(
    clipInput({ cameraName: "Doorbell", startAt: new Date("2026-03-29T13:01:04+02:00") }),
    db,
  );
  const protectEvent = (deviceId: string, start: string) =>
    upsertProtectEvent(
      {
        protectEventId: randomUUID(),
        protectDeviceId: deviceId,
        eventType: "smartDetectZone",
        startAt: new Date(start),
        smartDetectTypes: ["person"],
      },
      db,
    );
  const byDoorbell = await protectEvent(uniqueProtectId(), "2026-03-29T13:01:03+02:00");
  const byDriveway = await protectEvent(uniqueProtectId(), "2026-03-29T13:01:04+02:00");
  return { event, driveway, doorbell, byDoorbell, byDriveway };
}

describe("archive events", () => {
  it("groups several clips and Protect events into one archive event", async () => {
    const { event, driveway, doorbell, byDoorbell, byDriveway } = await multiCameraFixture();

    expect(await attachClipToArchiveEvent(event.id, driveway.id, db)).toBe(true);
    expect(await attachClipToArchiveEvent(event.id, doorbell.id, db)).toBe(true);
    expect(await attachProtectEventToArchiveEvent(event.id, byDriveway.id, db)).toBe(true);
    expect(await attachProtectEventToArchiveEvent(event.id, byDoorbell.id, db)).toBe(true);

    const loaded = await findArchiveEventById(event.id, db);
    expect(loaded).toMatchObject({ id: event.id, metadataStatus: "matched", endAt: event.endAt });
    // Earliest first.
    expect(loaded?.clips.map((clip) => clip.cameraName)).toEqual(["Doorbell", "Driveway"]);
    expect(loaded?.protectEvents.map((pe) => pe.id)).toEqual([byDoorbell.id, byDriveway.id]);
  });

  it("ignores duplicate links", async () => {
    const { event, driveway, byDriveway } = await multiCameraFixture();
    await attachClipToArchiveEvent(event.id, driveway.id, db);
    await attachProtectEventToArchiveEvent(event.id, byDriveway.id, db);

    expect(await attachClipToArchiveEvent(event.id, driveway.id, db)).toBe(false);
    expect(await attachProtectEventToArchiveEvent(event.id, byDriveway.id, db)).toBe(false);

    const clipLinks = await db.select().from(archiveEventClips).where(eq(archiveEventClips.archiveEventId, event.id));
    const protectLinks = await db
      .select()
      .from(archiveEventProtectEvents)
      .where(eq(archiveEventProtectEvents.archiveEventId, event.id));
    expect(clipLinks).toHaveLength(1);
    expect(protectLinks).toHaveLength(1);

    // The composite primary key also protects against inserts that bypass the repository.
    await expectDbError(
      db.insert(archiveEventClips).values({ archiveEventId: event.id, archivedClipId: driveway.id, primaryGroupId: event.id }),
      PgErrorCode.uniqueViolation,
    );
  });

  it("supports a pending event without clips and an open end", async () => {
    const event = await createArchiveEvent(
      { startAt: new Date("2026-10-06T07:43:50+02:00"), metadataStatus: "pendingClip" },
      db,
    );
    const loaded = await findArchiveEventById(event.id, db);
    expect(loaded).toMatchObject({ endAt: null, metadataStatus: "pendingClip", clips: [], protectEvents: [] });
  });

  it("returns undefined for unknown or malformed IDs", async () => {
    expect(await findArchiveEventById(randomUUID(), db)).toBeUndefined();
    expect(await findArchiveEventById("evt-20261006-074213", db)).toBeUndefined();
  });

  it("rejects unknown statuses and links to missing rows", async () => {
    await expectDbError(
      db.execute(sql`insert into archive_events (start_at, metadata_status) values (now(), 'archived')`),
      PgErrorCode.checkViolation,
      "archive_events_metadata_status_valid",
    );
    const event = await createArchiveEvent({ startAt: new Date(), metadataStatus: "archiveOnly" }, db);
    await expectDbError(attachClipToArchiveEvent(event.id, randomUUID(), db), PgErrorCode.foreignKeyViolation);
  });
});
