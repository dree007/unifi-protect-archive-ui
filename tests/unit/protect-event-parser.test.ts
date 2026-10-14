import { describe, expect, it } from "vitest";

import { parseProtectMessage } from "@/server/protect/event-parser";

import { SYNTHETIC_EVENT } from "../support/fake-protect";

const json = (value: unknown) => JSON.stringify(value);
const withItem = (item: Record<string, unknown>, type = "add") =>
  json({ type, item: { ...SYNTHETIC_EVENT.add.item, ...item } });

describe("parseProtectMessage", () => {
  it("parses the synthetic ADD message", () => {
    expect(parseProtectMessage(json(SYNTHETIC_EVENT.add))).toEqual({
      kind: "event",
      event: {
        action: "add",
        protectEventId: "11111111-1111-4111-8111-111111111111",
        eventType: "smartDetectZone",
        protectDeviceId: "660000000000000000000001",
        startAt: new Date(1768471200000),
        endAt: undefined,
        smartDetectTypes: ["person"],
      },
    });
  });

  it("parses UPDATE messages with and without end", () => {
    const update = parseProtectMessage(json(SYNTHETIC_EVENT.update));
    expect(update).toMatchObject({ kind: "event", event: { action: "update", endAt: undefined } });

    const final = parseProtectMessage(json(SYNTHETIC_EVENT.finalUpdate));
    expect(final).toMatchObject({ kind: "event", event: { action: "update", endAt: new Date(1768471212610) } });
  });

  it("converts epoch milliseconds to the exact UTC instant", () => {
    const result = parseProtectMessage(json(SYNTHETIC_EVENT.finalUpdate));
    if (result.kind !== "event") throw new Error("expected an event");
    expect(result.event.startAt?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(result.event.endAt?.toISOString()).toBe("2026-01-15T10:00:12.610Z");
  });

  it("accepts unknown detection and event types as strings", () => {
    const result = parseProtectMessage(
      withItem({ type: "smartAudioDetect", smartDetectTypes: ["alrmSmoke", "someFutureType", 3, ""] }),
    );
    expect(result).toMatchObject({
      kind: "event",
      event: { eventType: "smartAudioDetect", smartDetectTypes: ["alrmSmoke", "someFutureType"] },
    });
  });

  it("allows partial updates (completed later from the stored event)", () => {
    const result = parseProtectMessage(
      json({ type: "update", item: { id: "11111111-1111-4111-8111-111111111111", modelKey: "event", end: 1768471212610 } }),
    );
    expect(result).toEqual({
      kind: "event",
      event: {
        action: "update",
        protectEventId: "11111111-1111-4111-8111-111111111111",
        eventType: undefined,
        protectDeviceId: undefined,
        startAt: undefined,
        endAt: new Date(1768471212610),
        smartDetectTypes: undefined,
      },
    });
  });

  describe("ignores", () => {
    it.each([
      ["other models", withItem({ modelKey: "camera" })],
      ["missing modelKey", withItem({ modelKey: undefined })],
      ["unknown message types", json({ ...SYNTHETIC_EVENT.add, type: "remove" })],
      ["messages without type", json({ item: SYNTHETIC_EVENT.add.item })],
    ])("%s", (_, raw) => {
      expect(parseProtectMessage(raw).kind).toBe("ignored");
    });
  });

  describe("rejects", () => {
    it.each([
      ["invalid JSON", "{not json", "not valid JSON"],
      ["non-object JSON", "[1,2]", "message is not a JSON object"],
      ["missing item", json({ type: "add" }), "add without item"],
      ["missing id", withItem({ id: undefined }), "add event without id"],
      ["empty id", withItem({ id: "" }), "add event without id"],
      ["missing start", withItem({ start: undefined }), "missing start"],
      ["start in seconds", withItem({ start: 1768471200 }), "invalid start"],
      ["non-numeric start", withItem({ start: "1768471200000" }), "invalid start"],
      ["end before start", withItem({ end: 1768471199999 }), "end before start"],
      ["missing device on add", withItem({ device: undefined }), "missing device"],
      ["missing type on add", withItem({ type: undefined }), "missing type"],
    ])("%s", (_, raw, reason) => {
      const result = parseProtectMessage(raw);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") expect(result.reason).toContain(reason);
    });
  });
});
