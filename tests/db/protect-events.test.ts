import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { protectEvents } from "@/server/db/schema";
import { upsertCamera } from "@/server/repositories/cameras";
import {
  findProtectEventByProtectEventId,
  upsertProtectEvent,
  type ProtectEventSnapshot,
} from "@/server/repositories/protect-events";

import { connectTestDb, uniqueProtectId } from "./helpers";

const { db } = connectTestDb();

/** Snapshot after the WebSocket `add` of the example event from Protect. */
function addMessage(overrides: Partial<ProtectEventSnapshot> = {}): ProtectEventSnapshot {
  return {
    protectEventId: crypto.randomUUID(), // e.g. 11111111-1111-4111-8111-111111111111
    protectDeviceId: "660000000000000000000001",
    eventType: "smartDetectZone",
    startAt: new Date(1768471200000),
    endAt: null,
    smartDetectTypes: ["person"],
    receivedAt: new Date("2026-01-15T10:00:13.000Z"),
    ...overrides,
  };
}

async function rowsFor(protectEventId: string) {
  return db.select().from(protectEvents).where(eq(protectEvents.protectEventId, protectEventId));
}

describe("protect events", () => {
  it("inserts on `add` and updates the same row on `update`", async () => {
    const add = addMessage();
    const inserted = await upsertProtectEvent(add, db);

    expect(inserted).toMatchObject({
      protectEventId: add.protectEventId,
      protectDeviceId: "660000000000000000000001",
      eventType: "smartDetectZone",
      startAt: new Date(1768471200000),
      endAt: null,
      smartDetectTypes: ["person"],
      cameraId: null,
    });
    expect(inserted.firstReceivedAt).toEqual(add.receivedAt);
    expect(inserted.lastReceivedAt).toEqual(add.receivedAt);

    const updateReceivedAt = new Date("2026-01-15T10:00:26.000Z");
    const updated = await upsertProtectEvent(
      { ...add, endAt: new Date(1768471212610), receivedAt: updateReceivedAt },
      db,
    );

    expect(updated.id).toBe(inserted.id);
    expect(updated.endAt).toEqual(new Date(1768471212610));
    expect(updated.firstReceivedAt).toEqual(add.receivedAt);
    expect(updated.lastReceivedAt).toEqual(updateReceivedAt);
    expect(updated.createdAt).toEqual(inserted.createdAt);
    expect(await rowsFor(add.protectEventId)).toHaveLength(1);
    expect(await findProtectEventByProtectEventId(add.protectEventId, db)).toEqual(updated);
  });

  it("does not clear `endAt` or `cameraId` when a later message lacks them", async () => {
    const camera = await upsertCamera({ protectDeviceId: uniqueProtectId(), name: "Garden", state: "online" }, db);
    const add = addMessage({ cameraId: camera.id, endAt: new Date(1768471212610) });
    await upsertProtectEvent(add, db);

    const later = await upsertProtectEvent(
      { ...add, cameraId: undefined, endAt: null, receivedAt: new Date("2026-01-15T10:01:00Z") },
      db,
    );
    expect(later.endAt).toEqual(new Date(1768471212610));
    expect(later.cameraId).toBe(camera.id);
  });

  it("accumulates detection types in first-seen order, including unknown future types", async () => {
    const add = addMessage({ smartDetectTypes: ["person"] });
    await upsertProtectEvent(add, db);
    await upsertProtectEvent({ ...add, smartDetectTypes: ["vehicle", "person"] }, db);
    const last = await upsertProtectEvent({ ...add, smartDetectTypes: ["someFutureType"] }, db);

    expect(last.smartDetectTypes).toEqual(["person", "vehicle", "someFutureType"]);
  });

  it("never moves `lastReceivedAt` backwards for out-of-order messages", async () => {
    const add = addMessage({ receivedAt: new Date("2026-01-15T10:00:20Z") });
    await upsertProtectEvent(add, db);
    const stale = await upsertProtectEvent({ ...add, receivedAt: new Date("2026-01-15T10:00:10Z") }, db);

    expect(stale.firstReceivedAt).toEqual(new Date("2026-01-15T10:00:20Z"));
    expect(stale.lastReceivedAt).toEqual(new Date("2026-01-15T10:00:20Z"));
  });

  it("creates exactly one row for concurrent messages of the same event", async () => {
    const add = addMessage();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertProtectEvent({ ...add, receivedAt: new Date(add.receivedAt!.getTime() + i * 1000) }, db),
      ),
    );

    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const rows = await rowsFor(add.protectEventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastReceivedAt).toEqual(new Date(add.receivedAt!.getTime() + 7000));
  });
});
