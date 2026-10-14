import { describe, expect, it } from "vitest";

import { toCameraState } from "@/server/protect/camera-sync";
import { parseCameraList, parseMetaInfo, ProtectPayloadError } from "@/server/protect/payloads";

import { protectCameras } from "../support/fake-protect";

describe("Protect payloads", () => {
  it("parses meta info", () => {
    expect(parseMetaInfo({ applicationVersion: "7.1.87", other: 1 })).toEqual({ applicationVersion: "7.1.87" });
    for (const body of [null, [], {}, { applicationVersion: 7 }, { applicationVersion: "" }]) {
      expect(() => parseMetaInfo(body)).toThrow(ProtectPayloadError);
    }
  });

  it("parses the real camera list", () => {
    const { cameras, invalid } = parseCameraList(protectCameras());
    expect(invalid).toEqual([]);
    expect(cameras).toHaveLength(6);
    expect(cameras[0]).toEqual({
      id: "660000000000000000000001",
      name: "Garden",
      state: "CONNECTED",
      mac: "020000000001",
      // Configured object types win over supported types.
      smartDetectTypes: ["vehicle", "person", "animal"],
    });
  });

  it("falls back to the supported detection types, then to none", () => {
    const [onlyFlags, onlySettings, neither] = parseCameraList([
      { id: "a", name: "A", state: "CONNECTED", featureFlags: { smartDetectTypes: ["person", "alrmSmoke"] } },
      { id: "b", name: "B", state: "CONNECTED", smartDetectSettings: { objectTypes: ["newFancyType"] } },
      { id: "c", name: "C", state: "CONNECTED", featureFlags: {}, smartDetectSettings: { objectTypes: "x" } },
    ]).cameras;
    expect(onlyFlags.smartDetectTypes).toEqual(["person", "alrmSmoke"]);
    expect(onlySettings.smartDetectTypes).toEqual(["newFancyType"]);
    expect(neither.smartDetectTypes).toEqual([]);
  });

  it("skips unusable entries without failing the list", () => {
    const result = parseCameraList([
      { id: "a", name: "A", state: "CONNECTED" },
      "garbage",
      { name: "no id", state: "CONNECTED" },
      { id: "b", name: "B" },
      { id: "c", state: "SOMETHING_NEW", mac: 42, smartDetectSettings: { objectTypes: ["person", 7, ""] } },
    ]);
    expect(result.cameras.map((camera) => camera.id)).toEqual(["a", "c"]);
    expect(result.cameras[1]).toEqual({ id: "c", name: "c", state: "SOMETHING_NEW", mac: null, smartDetectTypes: ["person"] });
    expect(result.invalid).toEqual([
      { index: 1, reason: "not an object" },
      { index: 2, reason: "missing id" },
      { index: 3, reason: "camera b: missing state" },
    ]);
  });

  it("rejects a response that is not a list", () => {
    expect(() => parseCameraList({ data: [] })).toThrow(ProtectPayloadError);
  });

  it("maps only CONNECTED to online", () => {
    expect(toCameraState("CONNECTED")).toBe("online");
    expect(toCameraState("connected")).toBe("online");
    for (const state of ["DISCONNECTED", "CONNECTING", "UPDATING", "SOMETHING_NEW"]) {
      expect(toCameraState(state)).toBe("offline");
    }
  });
});
