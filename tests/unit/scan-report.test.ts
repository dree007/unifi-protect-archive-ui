import { describe, expect, it } from "vitest";

import type { ScanResult } from "@/server/archive/archive-indexer";
import { formatDuration, formatScanResult } from "@/server/archive/scan-report";

const base: ScanResult = {
  status: "completed",
  runId: "0199b2c4-0000-7000-8000-000000000000",
  archiveRoot: "/archive",
  startedAt: new Date("2026-10-06T07:00:00.000Z"),
  finishedAt: new Date("2026-10-06T07:03:12.000Z"),
  counts: {
    dayDirectoryCount: 214,
    discoveredCount: 132,
    updatedCount: 18,
    unchangedCount: 18_277,
    failedCount: 5,
    warningCount: 2,
  },
  filesFound: 18_432,
  ignoredCount: 3,
  missingCount: 31,
  warnings: [],
  failures: [],
};

describe("scan report", () => {
  it("formats durations", () => {
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(192_000)).toBe("3 min 12 s");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
  });

  it("summarizes a completed scan", () => {
    const text = formatScanResult(base);
    expect(text).toMatch(/^Unifi Protect Archive UI scan completed\n/);
    expect(text).toMatch(/Duration: +3 min 12 s/);
    expect(text).toMatch(/MP4 files found: +18,432/);
    expect(text).toMatch(/Unchanged: +18,277/);
    expect(text).toMatch(/Missing \(not found\): +31/);
  });

  it("marks failed scans as not usable for missing detection", () => {
    const text = formatScanResult({ ...base, status: "failed", missingCount: null, errorMessage: "EHOSTDOWN: Host is down" });
    expect(text).toMatch(/^Unifi Protect Archive UI scan FAILED/);
    expect(text).not.toMatch(/Missing/);
    expect(text).toMatch(/Error: EHOSTDOWN: Host is down\nThis run is not used for missing-file detection\./);
  });

  it("shows indexable files instead of database outcomes in a dry run", () => {
    const text = formatScanResult({ ...base, status: "dryRun", runId: undefined, missingCount: null });
    expect(text).toMatch(/dry run, nothing written/);
    expect(text).toMatch(/Indexable: +18,427/);
    expect(text).not.toMatch(/New:/);
  });
});
