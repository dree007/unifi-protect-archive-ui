import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { cameras } from "@/server/db/schema";
import {
  findCameraByProtectDeviceId,
  listCameras,
  upsertCamera,
} from "@/server/repositories/cameras";

import { connectTestDb, expectDbError, PgErrorCode, uniqueProtectId } from "./helpers";

const { db } = connectTestDb();

describe("cameras", () => {
  it("inserts a new camera with a generated UUID", async () => {
    const protectDeviceId = uniqueProtectId();
    const camera = await upsertCamera(
      {
        protectDeviceId,
        name: "Garden",
        state: "online",
        mac: "F4E2C6A1B2C3",
        smartDetectTypes: ["person", "vehicle", "animal"],
      },
      db,
    );

    expect(camera.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // UUIDv7
    expect(camera.id).not.toBe(protectDeviceId);
    expect(camera).toMatchObject({
      protectDeviceId,
      name: "Garden",
      state: "online",
      model: null,
      mac: "F4E2C6A1B2C3",
      smartDetectTypes: ["person", "vehicle", "animal"],
    });
    expect(await findCameraByProtectDeviceId(protectDeviceId, db)).toEqual(camera);
  });

  it("updates the existing row when the camera is renamed in Protect", async () => {
    const protectDeviceId = uniqueProtectId();
    const first = await upsertCamera({ protectDeviceId, name: "Garage", state: "online" }, db);
    const renamed = await upsertCamera(
      { protectDeviceId, name: "Garage Süd", state: "offline", smartDetectTypes: ["person"] },
      db,
    );

    expect(renamed.id).toBe(first.id);
    expect(renamed.name).toBe("Garage Süd");
    expect(renamed.state).toBe("offline");
    expect(renamed.smartDetectTypes).toEqual(["person"]);
    expect(renamed.createdAt).toEqual(first.createdAt);
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());

    const rows = await db.select().from(cameras).where(eq(cameras.protectDeviceId, protectDeviceId));
    expect(rows).toHaveLength(1);
  });

  it("lists cameras by name", async () => {
    const a = await upsertCamera({ protectDeviceId: uniqueProtectId(), name: "AAA Driveway", state: "online" }, db);
    const z = await upsertCamera({ protectDeviceId: uniqueProtectId(), name: "zzz Doorbell", state: "online" }, db);
    const ids = (await listCameras(db)).map((camera) => camera.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(z.id));
  });

  it("returns undefined for an unknown Protect device ID", async () => {
    expect(await findCameraByProtectDeviceId(uniqueProtectId(), db)).toBeUndefined();
  });

  it("rejects unknown states and blank names", async () => {
    await expectDbError(
      db.execute(sql`insert into cameras (protect_device_id, name, state) values (${uniqueProtectId()}, 'X', 'broken')`),
      PgErrorCode.checkViolation,
      "cameras_state_valid",
    );
    await expectDbError(
      upsertCamera({ protectDeviceId: uniqueProtectId(), name: "  ", state: "online" }, db),
      PgErrorCode.checkViolation,
      "cameras_name_not_blank",
    );
  });
});
