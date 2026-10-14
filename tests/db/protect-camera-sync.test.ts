import { describe, expect, it } from "vitest";

import { cameras } from "@/server/db/schema";
import { syncProtectCameras } from "@/server/protect/camera-sync";
import { parseCameraList } from "@/server/protect/payloads";
import { findCameraByProtectDeviceId } from "@/server/repositories/cameras";

import { protectCameras } from "../support/fake-protect";
import { createIsolatedDb } from "./helpers";

/** Client stand-in returning the given raw camera payload (validated like the real client). */
const clientReturning = (payload: unknown[]) => ({ getCameras: async () => parseCameraList(payload) });

const GARDEN = "660000000000000000000001";
const EINFAHRT = "660000000000000000000002";

describe("syncProtectCameras", () => {
  it("creates all cameras on the first sync", async () => {
    const { db } = await createIsolatedDb();
    const syncedAt = new Date("2026-10-06T07:00:00Z");

    const result = await syncProtectCameras(clientReturning(protectCameras()), db, () => syncedAt);

    expect(result.received).toBe(6);
    expect(result.counts).toEqual({ inserted: 6, updated: 0, unchanged: 0 });
    expect(await db.select().from(cameras)).toHaveLength(6);
    expect(await findCameraByProtectDeviceId(GARDEN, db)).toMatchObject({
      name: "Garden",
      state: "online",
      protectState: "CONNECTED",
      mac: "020000000001",
      smartDetectTypes: ["vehicle", "person", "animal"],
      lastSeenAt: syncedAt,
    });
    expect(await findCameraByProtectDeviceId("660000000000000000000006", db)).toMatchObject({
      name: "Front Door",
      state: "offline",
      protectState: "DISCONNECTED",
      lastSeenAt: null,
    });
  });

  it("is idempotent: a second identical sync changes nothing", async () => {
    const { db } = await createIsolatedDb();
    await syncProtectCameras(clientReturning(protectCameras()), db);
    const before = await db.select().from(cameras).orderBy(cameras.protectDeviceId);

    const result = await syncProtectCameras(clientReturning(protectCameras()), db);

    expect(result.counts).toEqual({ inserted: 0, updated: 0, unchanged: 6 });
    const after = await db.select().from(cameras).orderBy(cameras.protectDeviceId);
    expect(after.map((c) => [c.id, c.updatedAt])).toEqual(before.map((c) => [c.id, c.updatedAt]));
  });

  it("updates the same row on rename, state change and new detection types", async () => {
    const { db } = await createIsolatedDb();
    await syncProtectCameras(clientReturning(protectCameras()), db, () => new Date("2026-10-06T07:00:00Z"));
    const original = await findCameraByProtectDeviceId(EINFAHRT, db);

    const changed = protectCameras().map((camera) =>
      camera.id === EINFAHRT
        ? {
            ...camera,
            name: "Driveway vorne",
            state: "DISCONNECTED",
            smartDetectSettings: { objectTypes: ["person", "vehicle", "licensePlate", "face"] },
          }
        : camera,
    );
    const result = await syncProtectCameras(clientReturning(changed), db, () => new Date("2026-10-06T08:00:00Z"));

    expect(result.counts).toEqual({ inserted: 0, updated: 1, unchanged: 5 });
    const renamed = await findCameraByProtectDeviceId(EINFAHRT, db);
    expect(renamed).toMatchObject({
      id: original!.id,
      name: "Driveway vorne",
      state: "offline",
      protectState: "DISCONNECTED",
      smartDetectTypes: ["person", "vehicle", "licensePlate", "face"],
      // Offline now: the last time it was seen connected is kept.
      lastSeenAt: new Date("2026-10-06T07:00:00Z"),
      createdAt: original!.createdAt,
    });
    expect(await db.select().from(cameras)).toHaveLength(6);
  });

  it("stores unknown detection types and unknown camera states", async () => {
    const { db } = await createIsolatedDb();
    const payload = [
      ...protectCameras(),
      {
        id: "650a1b2c03d4e5f6a7b8c9ff",
        name: "Carport",
        state: "FIRMWARE_UPDATING",
        smartDetectSettings: { objectTypes: ["person", "someFutureType"] },
      },
    ];

    const result = await syncProtectCameras(clientReturning(payload), db);

    expect(result.counts.inserted).toBe(7);
    expect(await findCameraByProtectDeviceId("650a1b2c03d4e5f6a7b8c9ff", db)).toMatchObject({
      state: "offline",
      protectState: "FIRMWARE_UPDATING",
      smartDetectTypes: ["person", "someFutureType"],
    });
  });

  it("skips unusable and duplicate entries but syncs the rest", async () => {
    const { db } = await createIsolatedDb();
    const [garden] = protectCameras();
    const result = await syncProtectCameras(
      clientReturning([garden, { name: "no id", state: "CONNECTED" }, { ...garden, name: "Garden (dup)" }]),
      db,
    );
    expect(result.received).toBe(3);
    expect(result.invalid.map((entry) => entry.reason)).toEqual(["missing id", `duplicate camera id ${GARDEN}`]);
    expect(await db.select().from(cameras)).toHaveLength(1);
  });

  it("fails as a whole when Protect cannot be read", async () => {
    const { db } = await createIsolatedDb();
    const failing = { getCameras: async () => Promise.reject(new Error("HTTP 500")) };
    await expect(syncProtectCameras(failing, db)).rejects.toThrow("HTTP 500");
    expect(await db.select().from(cameras)).toEqual([]);
  });
});
