import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { archivedClips, archiveEvents, cameras } from "@/server/db/schema";
import { createArchivedClip, findArchivedClipByPath } from "@/server/repositories/archived-clips";
import {
  attachClipToArchiveEvent,
  attachProtectEventToArchiveEvent,
  createArchiveEvent,
  findArchiveEventById,
} from "@/server/repositories/archive-events";
import { upsertCamera } from "@/server/repositories/cameras";
import {
  findProtectEventByProtectEventId,
  upsertProtectEvent,
} from "@/server/repositories/protect-events";

import { clipInput, connectTestDb, uniqueProtectId } from "./helpers";

const { db } = connectTestDb();

async function eventWithCamera() {
  const protectDeviceId = uniqueProtectId();
  const camera = await upsertCamera({ protectDeviceId, name: "Front Door", state: "offline" }, db);
  const clip = await createArchivedClip(clipInput({ cameraId: camera.id, cameraName: "Front Door" }), db);
  const protectEvent = await upsertProtectEvent(
    {
      protectEventId: randomUUID(),
      protectDeviceId,
      cameraId: camera.id,
      eventType: "smartDetectZone",
      startAt: clip.startAt,
      endAt: clip.endAt,
      smartDetectTypes: ["person"],
    },
    db,
  );
  const event = await createArchiveEvent(
    { startAt: clip.startAt, endAt: clip.endAt, metadataStatus: "matched" },
    db,
  );
  await attachClipToArchiveEvent(event.id, clip.id, db);
  await attachProtectEventToArchiveEvent(event.id, protectEvent.id, db);
  return { camera, clip, protectEvent, event };
}

describe("delete behavior", () => {
  it("keeps clips, Protect events and archive events when their camera is deleted", async () => {
    const { camera, clip, protectEvent, event } = await eventWithCamera();

    await db.delete(cameras).where(eq(cameras.id, camera.id));

    const keptClip = await findArchivedClipByPath(clip.filePath, db);
    expect(keptClip).toMatchObject({ id: clip.id, cameraId: null, cameraName: "Front Door" });

    const keptEvent = await findProtectEventByProtectEventId(protectEvent.protectEventId, db);
    expect(keptEvent).toMatchObject({ id: protectEvent.id, cameraId: null, protectDeviceId: camera.protectDeviceId });

    const archiveEvent = await findArchiveEventById(event.id, db);
    expect(archiveEvent?.clips.map((c) => c.id)).toEqual([clip.id]);
    expect(archiveEvent?.protectEvents.map((pe) => pe.id)).toEqual([protectEvent.id]);
  });

  it("removes only the links when an archive event is deleted", async () => {
    const { clip, protectEvent, event } = await eventWithCamera();

    await db.delete(archiveEvents).where(eq(archiveEvents.id, event.id));

    expect(await findArchiveEventById(event.id, db)).toBeUndefined();
    expect(await findArchivedClipByPath(clip.filePath, db)).toBeDefined();
    expect(await findProtectEventByProtectEventId(protectEvent.protectEventId, db)).toBeDefined();
  });

  it("keeps the archive event when one of its clips is deleted", async () => {
    const { clip, protectEvent, event } = await eventWithCamera();

    await db.delete(archivedClips).where(eq(archivedClips.id, clip.id));

    const archiveEvent = await findArchiveEventById(event.id, db);
    expect(archiveEvent?.clips).toEqual([]);
    expect(archiveEvent?.protectEvents.map((pe) => pe.id)).toEqual([protectEvent.id]);
  });
});
