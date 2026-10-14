/**
 * Protect fixtures shared by the Vitest fake (fake-protect.ts) and the containerized fake of the
 * Docker integration test (tests/docker/fake-protect-server.mts). No test-framework imports.
 */

/** API key of the fake server; tests assert it never shows up in errors. */
export const FAKE_API_KEY = "test-api-key-c0ffee-5ecret";

export const PROTECT_API_BASE = "/proxy/protect/integration/v1";

/** Synthetic cameras shaped like the Protect Integration API. IDs and locally administered MACs
 * are deterministic test values, not identifiers of an installation. */
export function protectCameras(): Record<string, unknown>[] {
  return [
    {
      id: "660000000000000000000001",
      modelKey: "camera",
      state: "CONNECTED",
      name: "Garden",
      mac: "020000000001",
      featureFlags: { smartDetectTypes: ["person", "vehicle", "animal"] },
      smartDetectSettings: { objectTypes: ["vehicle", "person", "animal"] },
    },
    {
      id: "660000000000000000000002",
      modelKey: "camera",
      state: "CONNECTED",
      name: "Driveway",
      mac: "020000000002",
      featureFlags: { smartDetectTypes: ["person", "vehicle", "animal", "face", "licensePlate"] },
      smartDetectSettings: { objectTypes: ["person", "vehicle", "licensePlate"] },
    },
    {
      id: "660000000000000000000003",
      modelKey: "camera",
      state: "CONNECTED",
      name: "Doorbell",
      mac: "020000000003",
      featureFlags: { smartDetectTypes: ["person", "vehicle", "package", "face"] },
      smartDetectSettings: { objectTypes: ["person", "package"] },
    },
    { id: "660000000000000000000004", modelKey: "camera", state: "CONNECTED", name: "Garage", mac: "020000000004", featureFlags: { smartDetectTypes: ["person", "animal"] } },
    { id: "660000000000000000000005", modelKey: "camera", state: "CONNECTED", name: "Garage 2", mac: "020000000005", smartDetectSettings: { objectTypes: ["person"] } },
    { id: "660000000000000000000006", modelKey: "camera", state: "DISCONNECTED", name: "Front Door", mac: "020000000006" },
  ];
}

/** Synthetic add/update/end messages with a fixed 2026-01-15 timestamp. */
export const SYNTHETIC_EVENT = {
  add: {
    type: "add",
    item: {
      id: "11111111-1111-4111-8111-111111111111",
      modelKey: "event",
      type: "smartDetectZone",
      start: 1768471200000,
      device: "660000000000000000000001",
      smartDetectTypes: ["person"],
    },
  },
  update: {
    type: "update",
    item: {
      id: "11111111-1111-4111-8111-111111111111",
      modelKey: "event",
      type: "smartDetectZone",
      start: 1768471200000,
      device: "660000000000000000000001",
      smartDetectTypes: ["person"],
    },
  },
  finalUpdate: {
    type: "update",
    item: {
      id: "11111111-1111-4111-8111-111111111111",
      modelKey: "event",
      type: "smartDetectZone",
      start: 1768471200000,
      end: 1768471212610,
      device: "660000000000000000000001",
      smartDetectTypes: ["person"],
    },
  },
} as const;

/** A fresh copy of a synthetic message with another event ID (tests share databases). */
export function eventMessage(
  kind: keyof typeof SYNTHETIC_EVENT,
  overrides: Record<string, unknown> = {},
): { type: string; item: Record<string, unknown> } {
  const message = SYNTHETIC_EVENT[kind];
  return { type: message.type, item: { ...message.item, ...overrides } };
}
