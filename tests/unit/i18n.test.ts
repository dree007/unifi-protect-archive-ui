import { describe, expect, it } from "vitest";
import { createTranslator, detectLocale, type Locale, type Messages } from "@/i18n/core";
import de from "@/i18n/messages/de.json";
import en from "@/i18n/messages/en.json";
import { createDateFormat } from "@/lib/date-format";
import { formatNumber, formatRelative } from "@/lib/format";
import { detectionLabel } from "@/lib/labels";
import { eventTitle } from "@/lib/event-title";
import { operationError } from "@/i18n/errors";
import { addDays, startOfDayInZone } from "@/lib/time-zone";
import { detectionStyle } from "@/components/events/detection-badge";

const dictionaries = { de, en };
const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();

describe("translation contracts", () => {
  it("has identical keys, plural forms and parameters, with nonempty values except clock suffix", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    for (const key of Object.keys(de) as (keyof typeof de)[]) {
      const left = de[key], right = en[key];
      expect(typeof right, key).toBe(typeof left);
      const a: Record<string, string> = typeof left === "string" ? { value: left } : left;
      const b: Record<string, string> = typeof right === "string" ? { value: right } : right;
      expect(Object.keys(b).sort(), key).toEqual(Object.keys(a).sort());
      for (const form of Object.keys(a)) {
        expect(placeholders(b[form]!), key).toEqual(placeholders(a[form]!));
        if (key !== "events.clockSuffix") expect(b[form]!.trim().length, key).toBeGreaterThan(0);
      }
    }
  });
  for (const locale of ["de", "en"] as const) {
    const t = createTranslator(locale, dictionaries[locale]);
    it(`${locale}: plurals and safe interpolation, no raw keys`, () => {
      expect(t("counts.events", { count: 1 })).toBe(locale === "de" ? "1 Ereignis" : "1 event");
      expect(t("counts.events", { count: 1234 })).toBe(locale === "de" ? "1.234 Ereignisse" : "1,234 events");
      expect(t("archive.noMatches", { query: "<script>" })).toContain("<script>"); // React escapes text; no HTML parser.
      expect(() => t("events.videoLabel")).toThrow(/parameter/);
      for (const key of Object.keys(de) as (keyof typeof de)[]) {
        const value = t(key, { count: 2, online: 1, time: "12:00", failure: "", query: "test", label: "test", names: "test", start: "12:00", end: "12:01", camera: "Garden", unavailable: "", type: "Person", seconds: 30, version: "1.0.0" });
        expect(value, key).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    });
    it(`${locale}: localized labels preserve unknown types and internal codes`, () => {
      expect(detectionLabel("vehicle", t)).toBe(locale === "de" ? "Fahrzeug" : "Vehicle");
      expect(detectionLabel("someNewType", t)).toBe("Some new type");
      for (const [type, label] of [["constructor", "Constructor"], ["__proto__", "Proto"], ["toString", "To string"]]) {
        expect(detectionLabel(type, t)).toBe(label);
        expect(detectionLabel(type)).toBe(label);
        expect(detectionStyle(type)).toEqual(detectionStyle("someNewType"));
      }
      const event = { status: "pendingClip" as const, detectionTypes: [] };
      expect(eventTitle(event, t)).toBe(t("events.pending"));
      expect(event.status).toBe("pendingClip");
      expect(t("status.temporal")).toBe(locale === "de" ? "Zeitlich zugeordnet" : "Grouped by time");
      expect(t("status.metadata")).toBe(locale === "de" ? "Erkennungen abgeglichen" : "Matched using detections");
      expect(operationError("EACCES: /private/archive/password=secret", t)).toBe(t("errors.operation") + " (EACCES)");
    });
    it(`${locale}: locale affects display, not Berlin DST filter boundaries`, () => {
      const format = createDateFormat("Europe/Berlin", locale);
      expect(format.time(new Date("2026-03-29T01:30:00Z"))).toBe("03:30");
      expect(format.time(new Date("2026-10-25T00:30:00Z"))).toBe("02:30");
      expect(format.time(new Date("2026-10-25T01:30:00Z"))).toBe("02:30");
      expect(format.dayKey(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-29");
      for (const [day, hours] of [["2026-03-29", 23], ["2026-10-25", 25], ["2026-04-30", 24]] as const) {
        expect((startOfDayInZone(addDays(day, 1), format.timeZone).getTime() - startOfDayInZone(day, format.timeZone).getTime()) / 3600000).toBe(hours);
      }
      expect(format.date(new Date("2026-03-29T10:00Z"))).toBe(locale === "de" ? "29.03.2026" : "29 Mar 2026");
      expect(formatNumber(1234, locale)).toBe(locale === "de" ? "1.234" : "1,234");
      expect(formatRelative(new Date("2026-01-01T11:55Z"), new Date("2026-01-01T12:00Z"), locale)).toBe(locale === "de" ? "vor 5 Minuten" : "5 minutes ago");
    });
  }
  it("rejects missing keys explicitly", () => {
    expect(() => createTranslator("en", {} as Messages)("common.archive")).toThrow(/Missing translation/);
  });
});

describe("request locale", () => {
  it.each([
    ["de", "en-US", "de"], ["en", "de-DE", "en"], ["de-DE", "en-US", "en"],
    [undefined, "de-AT", "de"], [undefined, "de-CH", "de"], [undefined, "en-US", "en"],
    [undefined, "fr-FR, de-DE;q=0.8, en-GB;q=0.9", "en"], [undefined, "en;q=0.1,de;q=0.9", "de"],
    [undefined, "fr-FR,de;q=0.8", "de"], [undefined, "de;q=0", "en"],
    [undefined, "de;q=2,en;q=0.5", "en"], [undefined, "DE-de; q=0.900, en;q=0.800", "de"],
    ["../de", "xx", "en"], [undefined, null, "en"], [undefined, "*", "en"],
    [undefined, "de;q=0.8,en;q=0.8", "de"], [undefined, "de;q=wat,en", "en"],
  ])("cookie %s and header %s resolve %s", (cookie, header, expected) => {
    expect(detectLocale(cookie, header as string | null)).toBe(expected as Locale);
  });
});

describe("media display messages retain the HTTP/API security contract", () => {
  it("localizes JSON messages while preserving codes, Range and no-store headers", async () => {
    const { localizeMediaError } = await import("@/i18n/media-errors");
    const { mediaError } = await import("@/server/media/media-response");
    const t = createTranslator("en", en);
    const response = await localizeMediaError(mediaError(416, "range-not-satisfiable", { headers: { "Content-Range": "bytes */100" } }), t);
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */100");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "range-not-satisfiable", message: "Requested range unavailable" });
    const head = mediaError(404, "clip-not-found", { head: true });
    expect(await localizeMediaError(head, t)).toBe(head);
    const stream = new Response(new ReadableStream(), { status: 206 });
    expect(await localizeMediaError(stream, t)).toBe(stream);
    expect(stream.bodyUsed).toBe(false);
  });
});

it("marks generated unknown-camera labels without translating a user's identically named camera", async () => {
  const { eventCameras } = await import("@/server/view-models/archive-events");
  const base = { eventId: "synthetic-event", protectEventId: "synthetic", eventType: "smartDetectZone", smartDetectTypes: [], startAt: new Date("2026-01-15T10:00Z"), endAt: null, primaryGroupId: "synthetic-group" };
  const cameras = eventCameras([], [
    { ...base, cameraId: "synthetic-unknown", cameraName: null },
    { ...base, cameraId: "synthetic-named", cameraName: "Unbekannte Kamera" },
  ]);
  expect(cameras.find((camera) => camera.key === "synthetic-unknown")?.unknown).toBe(true);
  expect(cameras.find((camera) => camera.key === "synthetic-named")?.unknown).toBeUndefined();
});
