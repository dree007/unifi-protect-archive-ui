import { describe, expect, it } from "vitest";

import { parseRange } from "@/server/media/range";

const SIZE = 10_000;

describe("parseRange", () => {
  it("serves the whole file without a Range header", () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: "none" });
    expect(parseRange(undefined, SIZE)).toEqual({ kind: "none" });
  });

  it("parses closed, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-999", SIZE)).toEqual({ kind: "single", start: 0, end: 999 });
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "single", start: 1000, end: 9999 });
    expect(parseRange("bytes=-500", SIZE)).toEqual({ kind: "single", start: 9500, end: 9999 });
    expect(parseRange(" Bytes = 0-0 ", SIZE)).toEqual({ kind: "single", start: 0, end: 0 });
  });

  it("clamps ranges reaching beyond the end of the file", () => {
    expect(parseRange("bytes=9000-20000", SIZE)).toEqual({ kind: "single", start: 9000, end: 9999 });
    expect(parseRange("bytes=-20000", SIZE)).toEqual({ kind: "single", start: 0, end: 9999 });
  });

  it("serves the last byte", () => {
    expect(parseRange("bytes=9999-9999", SIZE)).toEqual({ kind: "single", start: 9999, end: 9999 });
    expect(parseRange("bytes=9999-", SIZE)).toEqual({ kind: "single", start: 9999, end: 9999 });
    expect(parseRange("bytes=-1", SIZE)).toEqual({ kind: "single", start: 9999, end: 9999 });
  });

  it("rejects ranges starting at or after the end", () => {
    expect(parseRange("bytes=10000-", SIZE)).toEqual({ kind: "unsatisfiable", reason: "not-satisfiable" });
    expect(parseRange("bytes=10000-10010", SIZE)).toEqual({ kind: "unsatisfiable", reason: "not-satisfiable" });
    expect(parseRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable", reason: "not-satisfiable" });
  });

  it("rejects an end before the start and broken syntax", () => {
    expect(parseRange("bytes=500-100", SIZE)).toMatchObject({ kind: "unsatisfiable", reason: "syntax" });
    for (const header of ["", "bytes", "bytes=", "bytes=-", "bytes=a-b", "bytes=1-2-3", "bytes=1.5-2", "bytes=+1-2", "bytes= -1-"]) {
      expect(parseRange(header, SIZE), header).toMatchObject({ kind: "unsatisfiable" });
    }
    expect(parseRange("items=0-1", SIZE)).toEqual({ kind: "unsatisfiable", reason: "unit" });
  });

  it("rejects several ranges deterministically (no multipart)", () => {
    expect(parseRange("bytes=0-1,5-6", SIZE)).toEqual({ kind: "unsatisfiable", reason: "multiple" });
    expect(parseRange("bytes=0-1, -5", SIZE)).toEqual({ kind: "unsatisfiable", reason: "multiple" });
    expect(parseRange("bytes=0-1,", SIZE)).toEqual({ kind: "unsatisfiable", reason: "multiple" });
  });

  it("never satisfies a range of an empty file", () => {
    expect(parseRange(null, 0)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-", 0)).toMatchObject({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-0", 0)).toMatchObject({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-10", 0)).toMatchObject({ kind: "unsatisfiable" });
  });

  it("handles very large files and numbers", () => {
    const big = 8 * 1024 ** 4; // 8 TiB
    expect(parseRange("bytes=8796093022000-", big)).toEqual({ kind: "single", start: 8796093022000, end: big - 1 });
    expect(parseRange("bytes=0-99999999999999999999999", big)).toEqual({ kind: "single", start: 0, end: big - 1 });
    expect(parseRange("bytes=99999999999999999999999-", big)).toEqual({ kind: "unsatisfiable", reason: "not-satisfiable" });
    expect(parseRange("bytes=-99999999999999999999999", big)).toEqual({ kind: "single", start: 0, end: big - 1 });
  });
});
