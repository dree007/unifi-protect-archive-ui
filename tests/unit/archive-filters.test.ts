import { describe, expect, it } from "vitest";

import {
  customRangeIssue,
  DEFAULT_ARCHIVE_FILTERS,
  detectionTypesForQuery,
  normalizeQuery,
  parseArchiveFilters,
  serializeArchiveFilters,
  type ArchiveFilters,
} from "@/lib/archive-filters";
import { periodRange } from "@/server/queries/archive";
import { DETECTION_KEYS } from "@/lib/labels";
import de from "@/i18n/messages/de.json";
import en from "@/i18n/messages/en.json";

const BERLIN = "Europe/Berlin";
const filters = (patch: Partial<ArchiveFilters>): ArchiveFilters => ({ ...DEFAULT_ARCHIVE_FILTERS, ...patch });
const hours = (range: { start?: Date; end?: Date }) => (range.end!.getTime() - range.start!.getTime()) / 3_600_000;

describe("search text", () => {
  it("trims, collapses whitespace, normalizes Unicode and limits the length", () => {
    expect(normalizeQuery("  Garden  ")).toBe("Garden");
    expect(normalizeQuery("Garage \t 2")).toBe("Garage 2");
    // „ä“ as a + combining diaeresis (macOS input) becomes the precomposed character.
    expect(normalizeQuery("Gärten")).toBe("Gärten");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(100);
    expect(normalizeQuery("   ")).toBe("");
  });

  it("is read from and written to the URL as q, other filters untouched", () => {
    const parsed = parseArchiveFilters(new URLSearchParams("q=%20Garden%20&period=7d"));
    expect(parsed).toMatchObject({ query: "Garden", period: "7d" });
    expect(serializeArchiveFilters({ ...parsed, query: "" }).toString()).toBe("period=7d");
    expect(serializeArchiveFilters({ ...parsed, query: "100% Garden" }).toString()).toBe("q=100%25+Garden&period=7d");
  });

  it("maps German labels and type names of detections, case-insensitively and exactly", () => {
    expect(detectionTypesForQuery("Person")).toEqual(["person"]);
    expect(detectionTypesForQuery("person")).toEqual(["person"]);
    expect(detectionTypesForQuery("FAHRZEUG")).toEqual(["vehicle"]);
    expect(detectionTypesForQuery("Paket")).toEqual(["package"]);
    expect(detectionTypesForQuery("licenseplate")).toEqual(["licensePlate"]);
    expect(detectionTypesForQuery("Pers")).toEqual([]); // no fuzzy/prefix matching
    expect(detectionTypesForQuery("Garden")).toEqual([]);
    expect(detectionTypesForQuery("")).toEqual([]);
  });

  it.each(["Licence plate", "License plate", "Kennzeichen", "licensePlate", "LICENCE PLATE", "  License\t  plate  ", " KeNnZeIcHeN "])("recognizes the plate alias %j", (query) => {
    expect(detectionTypesForQuery(query)).toEqual(["licensePlate"]);
  });

  it.each(Object.entries(DETECTION_KEYS))("recognizes both displayed labels and the internal value for %s", (type, key) => {
    for (const query of [type, de[key], en[key]]) {
      expect(detectionTypesForQuery(query), query).toEqual([type]);
      expect(detectionTypesForQuery(`  ${query.toUpperCase()}  `), query).toEqual([type]);
    }
  });

  it.each(["Driveway", "Front Door", "unknownDetection", "Licence", "plate", "licensePlate%", "person vehicle", "Fährzeug"])("keeps ordinary/unknown text out of detection matching: %s", (query) => {
    expect(detectionTypesForQuery(query)).toEqual([]);
  });
});

describe("custom range", () => {
  const issue = (query: string) => {
    const params = new URLSearchParams(query);
    return customRangeIssue(params, parseArchiveFilters(params));
  };

  it("accepts valid, open and single-day ranges", () => {
    expect(issue("period=custom&from=2026-10-01&to=2026-10-05")).toBeUndefined();
    expect(issue("period=custom&from=2026-10-05&to=2026-10-05")).toBeUndefined();
    expect(issue("period=custom&from=2026-10-01")).toBeUndefined();
    expect(issue("period=custom")).toBeUndefined();
  });

  it("explains invalid dates instead of dropping them silently", () => {
    expect(issue("period=custom&from=2026-02-30&to=2026-03-02")).toBe("invalid-from");
    expect(issue("period=custom&from=2026-03-01&to=05.10.2026")).toBe("invalid-to");
  });

  it("never swaps a start after the end", () => {
    expect(issue("period=custom&from=2026-10-05&to=2026-10-01")).toBe("from-after-to");
    const reversed = parseArchiveFilters(new URLSearchParams("period=custom&from=2026-10-05&to=2026-10-01"));
    expect(reversed).toMatchObject({ from: "2026-10-05", to: "2026-10-01" });
    const range = periodRange(reversed, new Date("2026-10-09T10:00:00Z"), BERLIN);
    expect(range.start!.getTime()).toBeGreaterThan(range.end!.getTime()); // empty, not swapped
  });

  it("ignores range parameters outside the custom period", () => {
    expect(issue("period=7d&from=kaputt")).toBeUndefined();
  });
});

describe("period boundaries in Europe/Berlin", () => {
  it("custom 01.10.–05.10.2026 covers [1 Oct 00:00, 6 Oct 00:00) local time", () => {
    const range = periodRange(filters({ period: "custom", from: "2026-10-01", to: "2026-10-05" }), new Date("2026-10-09T10:00:00Z"), BERLIN);
    expect(range).toEqual({ start: new Date("2026-09-30T22:00:00Z"), end: new Date("2026-10-05T22:00:00Z") });
  });

  it("today has 23 hours on 29 March 2026 (DST start)", () => {
    const range = periodRange(filters({ period: "today" }), new Date("2026-03-29T12:00:00Z"), BERLIN);
    expect(range).toEqual({ start: new Date("2026-03-28T23:00:00Z"), end: new Date("2026-03-29T22:00:00Z") });
    expect(hours(range)).toBe(23);
  });

  it("today has 25 hours on 25 October 2026 (DST end)", () => {
    const range = periodRange(filters({ period: "today" }), new Date("2026-10-25T12:00:00Z"), BERLIN);
    expect(range).toEqual({ start: new Date("2026-10-24T22:00:00Z"), end: new Date("2026-10-25T23:00:00Z") });
    expect(hours(range)).toBe(25);
  });

  it("today follows the Berlin calendar day, not UTC (00:30 local = previous UTC day)", () => {
    const range = periodRange(filters({ period: "today" }), new Date("2026-10-08T22:30:00Z"), BERLIN);
    expect(range.start).toEqual(new Date("2026-10-08T22:00:00Z")); // 9 Oct 00:00 Berlin
  });

  it("7 / 30 days are today plus the previous 6 / 29 calendar days, also across DST", () => {
    const now = new Date("2026-10-27T09:00:00Z"); // two days after the DST end
    expect(periodRange(filters({ period: "7d" }), now, BERLIN)).toEqual({ start: new Date("2026-10-20T22:00:00Z") }); // 21 Oct, CEST
    expect(periodRange(filters({ period: "30d" }), now, BERLIN)).toEqual({ start: new Date("2026-09-27T22:00:00Z") }); // 28 Sep
  });

  it("a custom range over the DST start ends at the right local midnight", () => {
    const range = periodRange(filters({ period: "custom", from: "2026-03-29", to: "2026-03-29" }), new Date("2026-04-02T10:00:00Z"), BERLIN);
    expect(hours(range)).toBe(23);
  });
});
