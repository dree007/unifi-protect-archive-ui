import { describe, expect, it } from "vitest";

import { resolveCameraName } from "@/server/matching/camera-names";
import { MATCH_TIME_TOLERANCE_MS, MULTI_CAMERA_GROUP_TOLERANCE_MS } from "@/server/matching/config";
import { groupComponents } from "@/server/matching/grouping";
import { calculateTemporalMatch, canGroupAcrossCameras, isClipMatch } from "@/server/matching/temporal-match";

/** Times on 2026-03-29 in UTC, written as "13:01:04" for readability. */
const t = (time: string) => new Date(`2026-03-29T${time}.000Z`);
const interval = (start: string, end: string | null) => ({ startAt: t(start), endAt: end === null ? null : t(end) });
const TOL = MATCH_TIME_TOLERANCE_MS;

describe("calculateTemporalMatch", () => {
  it("matches fully overlapping intervals", () => {
    expect(calculateTemporalMatch(interval("13:01:00", "13:01:30"), interval("13:01:00", "13:01:30"), TOL)).toEqual({
      isCandidate: true,
      overlapMs: 30_000,
      gapMs: 0,
      startDeltaMs: 0,
      endDeltaMs: 0,
    });
  });

  it("matches a Protect event inside the clip and a clip inside the Protect event", () => {
    const clip = interval("13:01:00", "13:02:30");
    const protect = interval("13:01:10", "13:01:20");
    expect(calculateTemporalMatch(protect, clip, TOL)).toMatchObject({ isCandidate: true, overlapMs: 10_000, startDeltaMs: -10_000, endDeltaMs: 70_000 });
    expect(calculateTemporalMatch(clip, protect, TOL)).toMatchObject({ isCandidate: true, overlapMs: 10_000 });
  });

  it("matches touching intervals", () => {
    expect(calculateTemporalMatch(interval("13:01:00", "13:01:10"), interval("13:01:10", "13:01:20"), TOL)).toMatchObject({
      isCandidate: true,
      overlapMs: 0,
      gapMs: 0,
    });
  });

  it("matches a 4 s gap but not a 6 s gap at 5 s tolerance", () => {
    expect(calculateTemporalMatch(interval("13:01:00", "13:01:10"), interval("13:01:14", "13:01:20"), TOL)).toMatchObject({
      isCandidate: true,
      gapMs: 4000,
    });
    expect(calculateTemporalMatch(interval("13:01:00", "13:01:10"), interval("13:01:16", "13:01:20"), TOL)).toMatchObject({
      isCandidate: false,
      gapMs: 6000,
      reason: "tooFarApart",
    });
  });

  it("never matches an open interval (no invented end)", () => {
    expect(calculateTemporalMatch(interval("13:01:10", null), interval("13:01:00", "13:02:30"), TOL)).toMatchObject({
      isCandidate: false,
      reason: "openInterval",
    });
  });

  it("rejects inverted intervals defensively", () => {
    expect(calculateTemporalMatch(interval("13:01:20", "13:01:10"), interval("13:01:00", "13:02:30"), TOL)).toMatchObject({
      isCandidate: false,
      reason: "invalidInterval",
    });
  });
});

describe("isClipMatch", () => {
  const clip = { cameraId: "doorbell", ...interval("13:01:04", "13:02:18") };

  it("requires the same known camera, regardless of time", () => {
    expect(isClipMatch(clip, { cameraId: "doorbell", ...interval("13:01:04", "13:01:18") }, TOL)).toBe(true);
    expect(isClipMatch(clip, { cameraId: "driveway", ...interval("13:01:04", "13:01:18") }, TOL)).toBe(false);
    expect(isClipMatch({ ...clip, cameraId: null }, { cameraId: null, ...interval("13:01:04", "13:01:18") }, TOL)).toBe(false);
  });

  it("does not match an ongoing Protect event", () => {
    expect(isClipMatch(clip, { cameraId: "doorbell", ...interval("13:01:04", null) }, TOL)).toBe(false);
  });
});

describe("canGroupAcrossCameras", () => {
  const event = (cameraId: string, types: string[], start: string, end: string | null) => ({
    cameraId,
    smartDetectTypes: types,
    ...interval(start, end),
  });
  const TOL3 = MULTI_CAMERA_GROUP_TOLERANCE_MS;

  it("groups different cameras with a shared type close in time", () => {
    expect(canGroupAcrossCameras(event("doorbell", ["person"], "13:01:04", "13:01:18"), event("driveway", ["person", "vehicle"], "13:01:05", "13:01:19"), TOL3)).toBe(true);
  });

  it("never groups by time alone", () => {
    expect(canGroupAcrossCameras(event("garden", ["person"], "13:01:04", "13:01:18"), event("driveway", ["vehicle"], "13:01:04", "13:01:18"), TOL3)).toBe(false);
    expect(canGroupAcrossCameras(event("garden", [], "13:01:04", "13:01:18"), event("driveway", [], "13:01:04", "13:01:18"), TOL3)).toBe(false);
  });

  it("does not group events more than 3 s apart", () => {
    expect(canGroupAcrossCameras(event("doorbell", ["person"], "13:01:00", "13:01:10"), event("driveway", ["person"], "13:01:13", "13:01:20"), TOL3)).toBe(true);
    expect(canGroupAcrossCameras(event("doorbell", ["person"], "13:01:00", "13:01:10"), event("driveway", ["person"], "13:01:14", "13:01:20"), TOL3)).toBe(false);
  });

  it("never groups the same camera or an ongoing event", () => {
    expect(canGroupAcrossCameras(event("garden", ["person"], "13:01:10", "13:01:12"), event("garden", ["person"], "13:01:10", "13:01:12"), TOL3)).toBe(false);
    expect(canGroupAcrossCameras(event("doorbell", ["person"], "13:01:04", null), event("driveway", ["person"], "13:01:05", "13:01:19"), TOL3)).toBe(false);
  });
});

describe("resolveCameraName", () => {
  const cameras = [
    { id: "garden", name: "Garden" },
    { id: "gaeste", name: "Gäste-Eingang" },
    { id: "driveway", name: "Driveway " },
    { id: "hof", name: "Hof" },
    { id: "hof-lower", name: "hof" },
  ];

  it("matches exactly after NFC normalization and trimming", () => {
    expect(resolveCameraName("Garden", cameras)).toBe("garden");
    expect(resolveCameraName("Gäste-Eingang", cameras)).toBe("gaeste");
    expect(resolveCameraName("  Driveway", cameras)).toBe("driveway");
  });

  it("uses a case-insensitive match only if it is unique", () => {
    expect(resolveCameraName("GARDEN", cameras)).toBe("garden");
    expect(resolveCameraName("Hof", cameras)).toBe("hof"); // exact wins
    expect(resolveCameraName("HOF", cameras)).toBeUndefined(); // two case-insensitive candidates
  });

  it("does not guess", () => {
    for (const name of ["Gard", "Garden West", "Gardens", "", "  "]) {
      expect(resolveCameraName(name, cameras)).toBeUndefined();
    }
    expect(resolveCameraName("Garden", [...cameras, { id: "garden-2", name: "Garden" }])).toBeUndefined();
  });
});

describe("groupComponents", () => {
  const span = (startSec: number, endSec: number) => ({ startMs: startSec * 1000, endMs: endSec * 1000 });

  it("follows links unconditionally and multi-camera edges within the span", () => {
    const result = groupComponents({
      nodes: ["clip:1", "pe:a", "pe:b", "clip:2", "event:x"],
      links: [["clip:1", "pe:a"], ["event:x", "clip:2"]],
      groupEdges: [["pe:a", "pe:b"]],
      protectSpans: new Map([["pe:a", span(0, 10)], ["pe:b", span(1, 11)]]),
      maxSpanMs: 30_000,
    });
    expect(result.components).toEqual([["clip:1", "pe:a", "pe:b"], ["clip:2", "event:x"]]);
    expect(result.groupEdgesApplied).toBe(1);
  });

  it("groups three cameras transitively (A–B, B–C) within the span", () => {
    const result = groupComponents({
      nodes: ["pe:a", "pe:b", "pe:c"],
      links: [],
      groupEdges: [["pe:a", "pe:b"], ["pe:b", "pe:c"]],
      protectSpans: new Map([["pe:a", span(0, 5)], ["pe:b", span(7, 12)], ["pe:c", span(14, 20)]]),
      maxSpanMs: 30_000,
    });
    expect(result.components).toEqual([["pe:a", "pe:b", "pe:c"]]);
  });

  it("stops a long chain at the maximum span", () => {
    // 20 events, each 2 s long and 2 s after the previous one: neighbours are close, the chain is 78 s long.
    const nodes = Array.from({ length: 20 }, (_, i) => `pe:${String(i).padStart(2, "0")}`);
    const result = groupComponents({
      nodes,
      links: [],
      groupEdges: nodes.slice(1).map((node, i): [string, string] => [nodes[i], node]),
      protectSpans: new Map(nodes.map((node, i) => [node, span(i * 4, i * 4 + 2)])),
      maxSpanMs: 30_000,
    });
    expect(result.components.length).toBeGreaterThan(1);
    for (const component of result.components) {
      const spans = component.map((node) => span(Number(node.slice(3)) * 4, Number(node.slice(3)) * 4 + 2));
      expect(Math.max(...spans.map((s) => s.endMs)) - Math.min(...spans.map((s) => s.startMs))).toBeLessThanOrEqual(30_000);
    }
    expect(result.groupEdgesRejected).toBeGreaterThan(0);
  });

  it("is deterministic regardless of input order", () => {
    const input = {
      nodes: ["pe:c", "pe:a", "pe:b", "clip:1"],
      links: [["clip:1", "pe:c"]] as [string, string][],
      groupEdges: [["pe:b", "pe:c"], ["pe:a", "pe:b"]] as [string, string][],
      protectSpans: new Map([["pe:a", span(0, 5)], ["pe:b", span(3, 8)], ["pe:c", span(6, 40)]]),
      maxSpanMs: 30_000,
    };
    const reversed = { ...input, nodes: [...input.nodes].reverse(), groupEdges: [...input.groupEdges].reverse() };
    expect(groupComponents(input)).toEqual(groupComponents(reversed));
  });
});
