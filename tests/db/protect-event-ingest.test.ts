import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { protectEvents } from "@/server/db/schema";
import { syncProtectCameras } from "@/server/protect/camera-sync";
import { ProtectEventIngest } from "@/server/protect/event-ingest";
import type { ProtectLogger } from "@/server/protect/logger";
import { parseCameraList } from "@/server/protect/payloads";
import { findCameraByProtectDeviceId } from "@/server/repositories/cameras";

import { eventMessage, protectCameras, SYNTHETIC_EVENT } from "../support/fake-protect";
import { createIsolatedDb } from "./helpers";

const EVENT_ID = SYNTHETIC_EVENT.add.item.id;
const GARDEN = SYNTHETIC_EVENT.add.item.device;

function recordingLogger() {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] };
  const logger: ProtectLogger = {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m),
  };
  return { logger, lines };
}

async function setup({ syncCameras = true } = {}) {
  const { db } = await createIsolatedDb();
  if (syncCameras) await syncProtectCameras({ getCameras: async () => parseCameraList(protectCameras()) }, db);
  const { logger, lines } = recordingLogger();
  let clock = new Date("2026-10-06T05:38:36.400Z").getTime();
  const now = () => new Date((clock += 1000));
  const ingest = new ProtectEventIngest({ db, logger, now });
  const rows = (id = EVENT_ID) => db.select().from(protectEvents).where(eq(protectEvents.protectEventId, id));
  return { db, ingest, rows, lines, now };
}

const send = (ingest: ProtectEventIngest, message: unknown) => ingest.handle(JSON.stringify(message));

describe("Protect event ingest", () => {
  it("stores the synthetic event: add, several updates, final update with end", async () => {
    const { db, ingest, rows } = await setup();
    const garden = await findCameraByProtectDeviceId(GARDEN, db);

    const added = await send(ingest, SYNTHETIC_EVENT.add);
    expect(added).toMatchObject({ kind: "stored", cameraName: "Garden" });
    let [row] = await rows();
    expect(row).toMatchObject({
      protectEventId: EVENT_ID,
      cameraId: garden!.id,
      protectDeviceId: GARDEN,
      eventType: "smartDetectZone",
      startAt: new Date(1768471200000),
      endAt: null,
      smartDetectTypes: ["person"],
    });
    const firstReceivedAt = row.firstReceivedAt;

    await send(ingest, SYNTHETIC_EVENT.update);
    await send(ingest, SYNTHETIC_EVENT.update);
    await send(ingest, SYNTHETIC_EVENT.finalUpdate);

    const all = await rows();
    expect(all).toHaveLength(1);
    [row] = all;
    expect(row.endAt).toEqual(new Date(1768471212610));
    expect(row.firstReceivedAt).toEqual(firstReceivedAt);
    expect(row.lastReceivedAt.getTime()).toBe(firstReceivedAt.getTime() + 3000);
  });

  it("merges detection types across updates and keeps unknown ones", async () => {
    const { ingest, rows } = await setup();
    await send(ingest, eventMessage("add", { smartDetectTypes: ["person"] }));
    await send(ingest, eventMessage("update", { smartDetectTypes: ["vehicle"] }));
    await send(ingest, eventMessage("finalUpdate", { smartDetectTypes: ["person", "someFutureType"] }));

    const [row] = await rows();
    expect(row.smartDetectTypes).toEqual(["person", "vehicle", "someFutureType"]);
  });

  it("stores events of unknown devices without camera and warns once", async () => {
    const { ingest, rows, lines } = await setup();
    const device = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await send(ingest, eventMessage("add", { device }));
    await send(ingest, eventMessage("finalUpdate", { device }));

    const [row] = await rows();
    expect(row).toMatchObject({ cameraId: null, protectDeviceId: device, endAt: new Date(1768471212610) });
    expect(lines.warn.filter((line) => line.includes(device))).toHaveLength(1);
  });

  it("re-syncs cameras for an unknown device at most once per cooldown", async () => {
    const { db } = await setup({ syncCameras: false });
    const resync = vi.fn(() => syncProtectCameras({ getCameras: async () => parseCameraList(protectCameras()) }, db));
    let time = 0;
    const ingest = new ProtectEventIngest({ db, resyncCameras: resync, resyncCooldownMs: 60_000, now: () => new Date(Date.UTC(2026, 9, 6) + time) });

    // The camera appears through the re-sync, so the very first event gets its camera.
    const first = await send(ingest, eventMessage("add"));
    expect(first).toMatchObject({ kind: "stored", cameraName: "Garden" });
    expect(resync).toHaveBeenCalledTimes(1);

    // Further unknown devices: no re-sync within the cooldown (not per message, not per device) …
    await send(ingest, eventMessage("add", { id: "e2", device: "bbbbbbbbbbbbbbbbbbbbbbbb" }));
    await send(ingest, eventMessage("add", { id: "e3", device: "bbbbbbbbbbbbbbbbbbbbbbbb" }));
    time += 30_000;
    await send(ingest, eventMessage("add", { id: "e4", device: "cccccccccccccccccccccccc" }));
    expect(resync).toHaveBeenCalledTimes(1);
    // … but again once it has passed.
    time += 60_000;
    await send(ingest, eventMessage("add", { id: "e5", device: "cccccccccccccccccccccccc" }));
    expect(resync).toHaveBeenCalledTimes(2);
    expect(await db.select().from(protectEvents)).toHaveLength(5);
  });

  it("completes a partial update from the stored event", async () => {
    const { ingest, rows } = await setup();
    await send(ingest, SYNTHETIC_EVENT.add);
    const result = await send(ingest, { type: "update", item: { id: EVENT_ID, modelKey: "event", end: 1768471212610 } });

    expect(result.kind).toBe("stored");
    const [row] = await rows();
    expect(row).toMatchObject({ startAt: new Date(1768471200000), endAt: new Date(1768471212610), eventType: "smartDetectZone" });
  });

  it("skips invalid and irrelevant messages without storing anything", async () => {
    const { db, ingest, lines } = await setup();
    const results = [
      await ingest.handle("{broken"),
      await send(ingest, { type: "add", item: { ...SYNTHETIC_EVENT.add.item, id: undefined } }),
      await send(ingest, { type: "add", item: { ...SYNTHETIC_EVENT.add.item, start: undefined } }),
      await send(ingest, { type: "update", item: { id: "unknown-event", modelKey: "event", end: 1768471212610 } }),
      await send(ingest, { type: "add", item: { ...SYNTHETIC_EVENT.add.item, modelKey: "camera" } }),
      await send(ingest, { type: "remove", item: SYNTHETIC_EVENT.add.item }),
    ];
    expect(results.map((result) => result.kind)).toEqual(["invalid", "invalid", "invalid", "invalid", "ignored", "ignored"]);
    expect(lines.warn).toHaveLength(4);
    expect(await db.select().from(protectEvents)).toEqual([]);
  });

  it("handles many messages in quick succession without duplicates or loss", async () => {
    const { db, ingest } = await setup();
    const ids = Array.from({ length: 20 }, (_, i) => `burst-${i}`);
    // As the collector does: strictly one after the other, but without pauses.
    for (const id of ids) {
      await send(ingest, eventMessage("add", { id }));
      await send(ingest, eventMessage("update", { id, smartDetectTypes: ["person", "vehicle"] }));
      await send(ingest, eventMessage("finalUpdate", { id }));
    }
    const stored = await db.select().from(protectEvents);
    expect(stored).toHaveLength(20);
    for (const row of stored) {
      expect(row.endAt).toEqual(new Date(1768471212610));
      expect(row.smartDetectTypes).toEqual(["person", "vehicle"]);
    }
  });
});
