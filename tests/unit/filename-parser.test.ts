import { describe, expect, it } from "vitest";

import { parseClipFileName, type FileNameErrorCode } from "@/server/archive/filename-parser";

function parsed(fileName: string) {
  const result = parseClipFileName(fileName);
  if (!result.ok) throw new Error(`expected ${fileName} to parse: ${result.error.message}`);
  return result.value;
}

function expectError(fileName: string, code: FileNameErrorCode) {
  const result = parseClipFileName(fileName);
  expect(result.ok, `expected ${fileName} to be rejected`).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("parseClipFileName", () => {
  it("parses the reference example", () => {
    expect(parsed("Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4")).toEqual({
      cameraName: "Driveway",
      startAt: new Date("2026-03-29T11:01:05.000Z"),
      endAt: new Date("2026-03-29T11:02:18.000Z"),
      durationMs: 73_000,
      startLocalDate: "2026-03-29",
    });
  });

  it("parses morning times with two-digit hours", () => {
    const clip = parsed("Garden 3-29-2026, 11.20.45am GMT+2 - 3-29-2026, 11.21.04am GMT+2.mp4");
    expect(clip.cameraName).toBe("Garden");
    expect(clip.startAt.toISOString()).toBe("2026-03-29T09:20:45.000Z");
    expect(clip.endAt.toISOString()).toBe("2026-03-29T09:21:04.000Z");
    expect(clip.durationMs).toBe(19_000);
  });

  it.each([
    ["camera names with spaces", "Kamera Garden West", "Garage hinten"],
    ["camera names with dashes", "Carport-West", "Hof - Nord"],
    ["Unicode camera names", "Gäste-Eingang Süd", "Überdachung 2"],
  ])("keeps %s complete", (_, ...names) => {
    for (const name of names) {
      const clip = parsed(`${name} 3-29-2026, 11.20.45am GMT+2 - 3-29-2026, 11.21.04am GMT+2.mp4`);
      expect(clip.cameraName).toBe(name);
    }
  });

  it("normalizes decomposed Unicode camera names to NFC", () => {
    const decomposed = "Gäste"; // "Gäste" with a combining diaeresis, as some file systems store it
    const clip = parsed(`${decomposed} 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4`);
    expect(clip.cameraName).toBe("Gäste");
  });

  it("treats 12am as midnight and 12pm as noon", () => {
    const midnight = parsed("Driveway 3-29-2026, 12.05.00am GMT+1 - 3-29-2026, 12.06.00am GMT+1.mp4");
    expect(midnight.startAt.toISOString()).toBe("2026-03-28T23:05:00.000Z");
    expect(midnight.startLocalDate).toBe("2026-03-29");

    const noon = parsed("Driveway 3-29-2026, 12.05.00pm GMT+1 - 3-29-2026, 12.06.00pm GMT+1.mp4");
    expect(noon.startAt.toISOString()).toBe("2026-03-29T11:05:00.000Z");
  });

  it.each([
    ["GMT+1", "2026-01-15T12:00:00.000Z"],
    ["GMT+2", "2026-01-15T11:00:00.000Z"],
    ["GMT-1", "2026-01-15T14:00:00.000Z"],
    ["GMT-5", "2026-01-15T18:00:00.000Z"],
    ["GMT+5:30", "2026-01-15T07:30:00.000Z"],
    ["GMT", "2026-01-15T13:00:00.000Z"],
  ])("applies the explicit offset %s", (offset, expected) => {
    const clip = parsed(`Driveway 1-15-2026, 1.00.00pm ${offset} - 1-15-2026, 1.00.10pm ${offset}.mp4`);
    expect(clip.startAt.toISOString()).toBe(expected);
    expect(clip.durationMs).toBe(10_000);
  });

  it("handles single- and two-digit month and day values", () => {
    expect(parsed("Doorbell 1-5-2026, 9.00.00am GMT+1 - 1-5-2026, 9.00.30am GMT+1.mp4").startLocalDate).toBe(
      "2026-01-05",
    );
    expect(parsed("Doorbell 12-31-2026, 9.00.00am GMT+1 - 12-31-2026, 9.00.30am GMT+1.mp4").startLocalDate).toBe(
      "2026-12-31",
    );
  });

  it("handles clips across midnight", () => {
    const clip = parsed("Driveway 3-28-2026, 11.59.30pm GMT+1 - 3-29-2026, 12.00.45am GMT+1.mp4");
    expect(clip.startAt.toISOString()).toBe("2026-03-28T22:59:30.000Z");
    expect(clip.endAt.toISOString()).toBe("2026-03-28T23:00:45.000Z");
    expect(clip.durationMs).toBe(75_000);
    expect(clip.startLocalDate).toBe("2026-03-28");
  });

  it("handles different offsets for start and end (DST change)", () => {
    // 2026-03-29 02:00 CET → 03:00 CEST: 1:59:30am GMT+1 and 3:00:15am GMT+2 are 45 s apart.
    const clip = parsed("Driveway 3-29-2026, 1.59.30am GMT+1 - 3-29-2026, 3.00.15am GMT+2.mp4");
    expect(clip.startAt.toISOString()).toBe("2026-03-29T00:59:30.000Z");
    expect(clip.endAt.toISOString()).toBe("2026-03-29T01:00:15.000Z");
    expect(clip.durationMs).toBe(45_000);
  });

  it("accepts an upper-case extension", () => {
    expect(parsed("Garden 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.MP4").cameraName).toBe("Garden");
  });

  it("does not depend on the process time zone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(
          parsed("Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4").startAt.toISOString(),
        ).toBe("2026-03-29T11:01:05.000Z");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  describe("rejects", () => {
    it.each([
      ["invalid dates", "Driveway 2-30-2026, 1.01.05pm GMT+2 - 2-30-2026, 1.02.18pm GMT+2.mp4", "invalidDate"],
      ["invalid months", "Driveway 13-1-2026, 1.01.05pm GMT+2 - 13-1-2026, 1.02.18pm GMT+2.mp4", "invalidDate"],
      ["invalid hours", "Driveway 3-29-2026, 13.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4", "invalidTime"],
      ["hour 0", "Driveway 3-29-2026, 0.01.05am GMT+2 - 3-29-2026, 1.02.18am GMT+2.mp4", "invalidTime"],
      ["invalid minutes", "Driveway 3-29-2026, 1.61.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4", "invalidTime"],
      ["invalid offsets", "Driveway 3-29-2026, 1.01.05pm GMT+15 - 3-29-2026, 1.02.18pm GMT+15.mp4", "invalidOffset"],
      ["end before start", "Driveway 3-29-2026, 1.02.18pm GMT+2 - 3-29-2026, 1.01.05pm GMT+2.mp4", "endBeforeStart"],
      ["other extensions", "Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mkv", "notMp4"],
      ["unknown file names", "defekt.mp4", "unrecognizedFormat"],
      ["24-hour times", "Driveway 3-29-2026, 13.01.05 GMT+2 - 3-29-2026, 13.02.18 GMT+2.mp4", "unrecognizedFormat"],
      ["missing camera names", " 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4", "unrecognizedFormat"],
      ["ISO-style names", "Driveway 2026-03-29T13:01:05+02:00.mp4", "unrecognizedFormat"],
    ] as const)("%s", (_, fileName, code) => {
      expectError(fileName, code);
    });
  });
});
