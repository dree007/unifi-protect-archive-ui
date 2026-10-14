import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { protectEvents } from "@/server/db/schema";
import { reconcileArchive } from "@/server/matching/reconcile";
import { upsertArchivedClips, type ArchivedClipInput } from "@/server/repositories/archived-clips";
import { upsertCameras } from "@/server/repositories/cameras";

import { createIsolatedDb } from "./helpers";

const CAMERAS = 5;
const SLOTS = 200; // per camera → 1,000 clips and 1,000 Protect events
const SLOT_MS = 120_000;
const BASE = Date.UTC(2026, 9, 1, 6, 0, 0);

describe("reconciliation volume", () => {
  it("reconciles 1,000 clips and 1,000 Protect events correctly and fast", { timeout: 120_000 }, async () => {
    const { db } = await createIsolatedDb();
    const cameras = (
      await upsertCameras(
        Array.from({ length: CAMERAS }, (_, i) => ({
          protectDeviceId: `cam${String(i).padStart(21, "0")}`,
          name: `Kamera ${i}`,
          state: "online" as const,
        })),
        db,
      )
    ).map((result) => result.camera);

    const clips: ArchivedClipInput[] = [];
    const events: (typeof protectEvents.$inferInsert)[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      for (const [index, camera] of cameras.entries()) {
        // Cameras are 22 s apart (no grouping) – except every 10th slot, where cameras 0 and 1
        // see the same person 1 s apart (one multi-camera event).
        const offset = slot % 10 === 0 && index === 1 ? 1000 : index * 22_000;
        const clipStart = BASE + slot * SLOT_MS + offset;
        const fileName = `${camera.name} ${slot}.mp4`;
        clips.push({
          cameraName: camera.name,
          startAt: new Date(clipStart),
          endAt: new Date(clipStart + 40_000),
          durationMs: 40_000,
          filePath: `2026-10-01/${fileName}`,
          fileName,
          dayDirectory: "2026-10-01",
        });
        events.push({
          protectEventId: randomUUID(),
          protectDeviceId: camera.protectDeviceId,
          cameraId: camera.id,
          eventType: "smartDetectZone",
          startAt: new Date(clipStart + 5000),
          endAt: new Date(clipStart + 15_000),
          smartDetectTypes: ["person"],
          firstReceivedAt: new Date(clipStart + 5000),
          lastReceivedAt: new Date(clipStart + 15_000),
        });
      }
    }
    for (let i = 0; i < clips.length; i += 500) await upsertArchivedClips(clips.slice(i, i + 500), db);
    for (let i = 0; i < events.length; i += 500) await db.insert(protectEvents).values(events.slice(i, i + 500));

    const firstStarted = performance.now();
    const first = await reconcileArchive({ db });
    const firstMs = performance.now() - firstStarted;

    expect(first).toMatchObject({
      clipsTotal: 1000,
      protectEventsTotal: 1000,
      clipCamerasResolved: 1000,
      clipEventMatches: 1000,
      multiCameraEvents: 20,
      archiveEventsCreated: 980,
      status: { matched: 980, archiveOnly: 0, pendingClip: 0 },
    });

    const secondStarted = performance.now();
    const second = await reconcileArchive({ db });
    const secondMs = performance.now() - secondStarted;
    expect(second).toMatchObject({ relationsCreated: 0, archiveEventsCreated: 0, archiveEventsMerged: 0, eventsRecalculated: 0 });

    const links = await db.execute<{ n: number }>(sql`
      select (select count(*)::int from archive_event_clips) + (select count(*)::int from archive_event_protect_events) as n`);
    expect(links.rows[0].n).toBe(2000);

    console.log(`reconcile volume: first run ${firstMs.toFixed(0)} ms, second run ${secondMs.toFixed(0)} ms`);
    // Generous bound: catches accidental O(N×M) behaviour, not tuned for speed.
    expect(firstMs).toBeLessThan(30_000);
  });
});
