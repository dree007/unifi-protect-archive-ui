import { describe, expect, it } from "vitest";

import {
  DEFAULT_MATCHING_CONFIG,
  TEMPORAL_FALLBACK_END_TOLERANCE_MS,
  TEMPORAL_FALLBACK_MIN_IOU,
  TEMPORAL_FALLBACK_START_TOLERANCE_MS,
} from "@/server/matching/config";
import {
  calculateTemporalClipFallbackMatch,
  checkClusterLimits,
  clusterTemporalFallback,
  decideCrossCameraGrouping,
  type ClipWithMetadata,
  type FallbackGroup,
} from "@/server/matching/temporal-fallback";

/** Times on 2026-03-29 in UTC, written as "13:01:04" (optionally with ".500"). */
const t = (time: string) => new Date(`2026-03-29T${time}${time.includes(".") ? "" : ".000"}Z`);
const config = DEFAULT_MATCHING_CONFIG;

let nextId = 0;
const clip = (cameraId: string | null, start: string, end: string, id = `clip-${String(++nextId).padStart(4, "0")}`) => ({
  id,
  cameraId,
  startAt: t(start),
  endAt: t(end),
});
/** A clip with the Protect events that match it (types + time). */
const withMeta = (
  base: ReturnType<typeof clip>,
  ...events: { types: string[]; start: string; end: string }[]
): ClipWithMetadata => ({
  ...base,
  protectEvents: events.map((event) => ({
    cameraId: base.cameraId,
    startAt: t(event.start),
    endAt: t(event.end),
    smartDetectTypes: event.types,
  })),
});
const meta = (types: string[], start: string, end: string) => ({ types, start, end });

describe("temporal fallback constants", () => {
  it("are the documented defaults", () => {
    expect([TEMPORAL_FALLBACK_START_TOLERANCE_MS, TEMPORAL_FALLBACK_END_TOLERANCE_MS, TEMPORAL_FALLBACK_MIN_IOU]).toEqual([5000, 5000, 0.5]);
    expect(config).toMatchObject({
      temporalFallbackStartToleranceMs: 5000,
      temporalFallbackEndToleranceMs: 5000,
      temporalFallbackMinIou: 0.5,
    });
  });
});

describe("calculateTemporalClipFallbackMatch", () => {
  it("1. matches nearly identical start and end times (the real Driveway/Doorbell pair)", () => {
    const result = calculateTemporalClipFallbackMatch(
      clip("driveway", "13:01:05", "13:02:18"),
      clip("doorbell", "13:01:04", "13:02:18"),
      config,
    );
    expect(result).toMatchObject({ isCandidate: true, reason: "matched", startDeltaMs: 1000, endDeltaMs: 0, overlapMs: 73_000 });
    expect(result.intersectionOverUnion).toBeCloseTo(73 / 74, 5);
  });

  it("2. matches starts 2 s apart with enough overlap", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:02", "13:01:01"), config)).toMatchObject({
      isCandidate: true,
      startDeltaMs: 2000,
    });
  });

  it("3. matches starts 4 s apart (neighbouring cameras start their recordings with a delay)", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:04", "13:01:00"), config)).toMatchObject({
      isCandidate: true,
      startDeltaMs: 4000,
    });
  });

  it("3b. rejects starts 6 s apart", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:06", "13:01:00"), config)).toMatchObject({
      isCandidate: false,
      reason: "startTooFarApart",
      startDeltaMs: 6000,
    });
  });

  it("matches the real 3-minute pair: Driveway 11:13:08–11:16:17, Doorbell 11:13:07–11:16:15", () => {
    expect(calculateTemporalClipFallbackMatch(clip("driveway", "11:13:08", "11:16:17"), clip("doorbell", "11:13:07", "11:16:15"), config)).toMatchObject({
      isCandidate: true,
      startDeltaMs: 1000,
      endDeltaMs: 2000,
    });
  });

  it("matches short real clips with a lower overlap ratio (Driveway 14 s, Doorbell 10 s, IoU 0.71)", () => {
    const result = calculateTemporalClipFallbackMatch(clip("driveway", "11:12:44", "11:12:58"), clip("doorbell", "11:12:47", "11:12:57"), config);
    expect(result.intersectionOverUnion).toBeCloseTo(10 / 14, 5);
    expect(result.isCandidate).toBe(true);
  });

  it("4. matches ends 4 s apart with enough overlap", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:00", "13:01:04"), config)).toMatchObject({
      isCandidate: true,
      endDeltaMs: 4000,
    });
  });

  it("5. rejects ends 6 s apart", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:00", "13:01:06"), config)).toMatchObject({
      isCandidate: false,
      reason: "endTooFarApart",
      endDeltaMs: 6000,
    });
  });

  it("6. matches an IoU of 0.90 when everything else fits", () => {
    const result = calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:00:30"), clip("b", "13:00:00", "13:00:27"), config);
    expect(result.intersectionOverUnion).toBeCloseTo(0.9, 5);
    expect(result).toMatchObject({ isCandidate: true, reason: "matched" });
  });

  it("7. rejects a low IoU (0.375) even though starts and ends are within tolerance", () => {
    const result = calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:00:08"), clip("b", "13:00:02", "13:00:05"), config);
    expect(result.intersectionOverUnion).toBeCloseTo(0.375, 5);
    expect(result).toMatchObject({ isCandidate: false, reason: "insufficientOverlap", startDeltaMs: 2000, endDeltaMs: 3000 });
  });

  it("8. never groups the same camera", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("a", "13:00:00", "13:01:00"), config)).toMatchObject({
      isCandidate: false,
      reason: "sameCamera",
    });
  });

  it("9. never groups a clip without resolved camera", () => {
    expect(calculateTemporalClipFallbackMatch(clip(null, "13:00:00", "13:01:00"), clip("b", "13:00:00", "13:01:00"), config)).toMatchObject({
      isCandidate: false,
      reason: "unknownCamera",
    });
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip(null, "13:00:00", "13:01:00"), config).reason).toBe(
      "unknownCamera",
    );
  });

  it("10. rejects invalid intervals (end before or at start, invalid dates)", () => {
    const valid = clip("b", "13:00:00", "13:01:00");
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:01:00", "13:00:00"), valid, config).reason).toBe("invalidInterval");
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:00:00"), valid, config).reason).toBe("invalidInterval");
    const broken = { id: "x", cameraId: "a", startAt: new Date(Number.NaN), endAt: t("13:01:00") };
    expect(calculateTemporalClipFallbackMatch(broken, valid, config)).toMatchObject({ isCandidate: false, reason: "invalidInterval" });
  });

  it("11. rejects clips at different times without overlap", () => {
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:00:30"), clip("b", "14:00:00", "14:00:30"), config)).toMatchObject({
      isCandidate: false,
      reason: "startTooFarApart",
      overlapMs: 0,
      intersectionOverUnion: 0,
    });
  });

  it("12. rejects very different clip lengths (same start, short clip inside a long one)", () => {
    // Ends 5 s apart (within tolerance), but a 4 s clip vs. a 9 s clip: IoU 0.44.
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:00:04"), clip("b", "13:00:00", "13:00:09"), config)).toMatchObject({
      isCandidate: false,
      reason: "insufficientOverlap",
    });
  });

  it("is symmetric", () => {
    const a = clip("a", "13:00:00", "13:01:00");
    const b = clip("b", "13:00:02", "13:01:03");
    const ab = calculateTemporalClipFallbackMatch(a, b, config);
    const ba = calculateTemporalClipFallbackMatch(b, a, config);
    expect(ba).toEqual(ab);
  });

  it("uses the given configuration", () => {
    const strict = { ...config, temporalFallbackStartToleranceMs: 500 };
    expect(calculateTemporalClipFallbackMatch(clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:01", "13:01:00"), strict).reason).toBe(
      "startTooFarApart",
    );
  });
});

describe("decideCrossCameraGrouping (metadata first, time second)", () => {
  const driveway = () => clip("driveway", "13:01:05", "13:02:18");
  const doorbell = () => clip("doorbell", "13:01:04", "13:02:18");

  it("1. person + person, times fit → metadata grouping", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["person"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["person"], "13:01:04", "13:01:18")),
        config,
      ),
    ).toEqual({ method: "metadata" });
  });

  it("2. vehicle + vehicle → metadata grouping", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["vehicle"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["vehicle"], "13:01:06", "13:01:20")),
        config,
      ).method,
    ).toBe("metadata");
  });

  it("3. person vs. vehicle → no fallback, although the clips are nearly identical", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["person"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["vehicle"], "13:01:04", "13:01:18")),
        config,
      ),
    ).toEqual({ method: "none", reason: "metadataConflict" });
    for (const [x, y] of [
      ["person", "animal"],
      ["package", "person"],
    ]) {
      expect(
        decideCrossCameraGrouping(
          withMeta(driveway(), meta([x], "13:01:05", "13:01:19")),
          withMeta(doorbell(), meta([y], "13:01:04", "13:01:18")),
          config,
        ),
      ).toMatchObject({ method: "none", reason: "metadataConflict" });
    }
  });

  it("4. person + vehicle vs. vehicle → metadata grouping via the shared type", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["person", "vehicle"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["vehicle"], "13:01:04", "13:01:18")),
        config,
      ).method,
    ).toBe("metadata");
  });

  it("5. no metadata on either side, times fit → temporal fallback", () => {
    expect(decideCrossCameraGrouping(withMeta(driveway()), withMeta(doorbell()), config)).toMatchObject({
      method: "temporalFallback",
      temporal: { isCandidate: true, startDeltaMs: 1000 },
    });
  });

  it("6. person on one camera, nothing on the other, nearly identical clips → temporal fallback possible", () => {
    expect(
      decideCrossCameraGrouping(withMeta(driveway(), meta(["person"], "13:01:05", "13:01:19")), withMeta(doorbell()), config).method,
    ).toBe("temporalFallback");
  });

  it("6b. … but not if the times do not fit", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["person"], "13:01:05", "13:01:19")),
        withMeta(clip("doorbell", "13:01:04", "13:01:30")),
        config,
      ),
    ).toMatchObject({ method: "none", reason: "endTooFarApart" });
  });

  it("7. both with metadata but the metadata time rule fails → no fallback to get around it", () => {
    // Same type, but the Protect events are 40 s apart (> 3 s); the clips are nearly identical.
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["person"], "13:01:05", "13:01:10")),
        withMeta(doorbell(), meta(["person"], "13:01:50", "13:01:55")),
        config,
      ),
    ).toEqual({ method: "none", reason: "metadataRuleNotMet" });
  });

  it("8. compares unknown detection types as plain strings", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["licensePlate"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["licensePlate"], "13:01:04", "13:01:18")),
        config,
      ).method,
    ).toBe("metadata");
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta(["licensePlate"], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["smokeAlarm"], "13:01:04", "13:01:18")),
        config,
      ),
    ).toMatchObject({ method: "none", reason: "metadataConflict" });
  });

  it("treats Protect events without detection types (motion) as no usable metadata", () => {
    expect(
      decideCrossCameraGrouping(
        withMeta(driveway(), meta([], "13:01:05", "13:01:19")),
        withMeta(doorbell(), meta(["person"], "13:01:04", "13:01:18")),
        config,
      ).method,
    ).toBe("temporalFallback");
  });

  it("checks cameras before anything else", () => {
    expect(decideCrossCameraGrouping(withMeta(clip("a", "13:00:00", "13:01:00")), withMeta(clip("a", "13:00:00", "13:01:00")), config)).toEqual({
      method: "none",
      reason: "sameCamera",
    });
    expect(decideCrossCameraGrouping(withMeta(clip(null, "13:00:00", "13:01:00")), withMeta(clip("a", "13:00:00", "13:01:00")), config)).toEqual({
      method: "none",
      reason: "unknownCamera",
    });
  });
});

describe("checkClusterLimits", () => {
  it("checks the spans and the IoU of the whole cluster, not only of neighbours", () => {
    expect(checkClusterLimits([clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:02", "13:01:02")], config).valid).toBe(true);
    expect(
      checkClusterLimits([clip("a", "13:00:00", "13:01:00"), clip("b", "13:00:03", "13:01:03"), clip("c", "13:00:06", "13:01:04")], config),
    ).toMatchObject({ valid: false, reason: "startTooFarApart", startSpanMs: 6000 });
  });
});

// --- clusters --------------------------------------------------------------------------------

/** A primary group with one clip and no Protect events. */
const single = (camera: string | null, start: string, end: string): FallbackGroup => {
  const c = withMeta(clip(camera, start, end));
  return { key: `g-${c.id}`, clips: [c], cameraIds: camera ? [camera] : [] };
};
const allPairs = (groups: readonly FallbackGroup[]) => {
  const ids = groups.flatMap((group) => group.clips.map((c) => c.id));
  return ids.flatMap((a, i) => ids.slice(i + 1).map((b): [string, string] => [a, b]));
};
const cluster = (groups: FallbackGroup[], existingPairs: [string, string][] = []) =>
  clusterTemporalFallback({ groups, existingPairs, candidatePairs: allPairs(groups), config });
const keysOf = (...groups: FallbackGroup[]) => groups.map((group) => group.key).toSorted();

describe("clusterTemporalFallback", () => {
  it("1. groups two cameras with nearly identical clips", () => {
    const a = single("driveway", "13:01:05", "13:02:18");
    const b = single("doorbell", "13:01:04", "13:02:18");
    expect(cluster([a, b]).clusters).toEqual([keysOf(a, b)]);
  });

  it("2. groups three cameras with nearly identical clips", () => {
    const a = single("driveway", "13:01:05", "13:02:18");
    const b = single("doorbell", "13:01:04", "13:02:18");
    const c = single("garden", "13:01:06", "13:02:19");
    expect(cluster([a, b, c]).clusters).toEqual([keysOf(a, b, c)]);
  });

  it("3. four cameras, one outside the tolerance → no group of four", () => {
    const a = single("driveway", "13:01:05", "13:02:18");
    const b = single("doorbell", "13:01:04", "13:02:18");
    const c = single("garden", "13:01:06", "13:02:19");
    const d = single("carport", "13:01:11", "13:02:20"); // fits Garden (5 s), not Doorbell (7 s)
    const result = cluster([a, b, c, d]);
    expect(result.clusters).toEqual([keysOf(a, b, c)]);
    expect(result.candidatePairsRejectedByCluster).toBeGreaterThan(0);
  });

  it("4. a chain A/B/C/D, each start 3 s after the previous one, never becomes one cluster", () => {
    const groups = ["a", "b", "c", "d"].map((camera, i) => single(camera, `13:00:0${i * 3}`, `13:01:0${i * 3}`));
    const result = cluster(groups);
    expect(result.clusters).toEqual([keysOf(groups[0], groups[1]), keysOf(groups[2], groups[3])]);
    for (const keys of result.clusters) {
      const clips = groups.filter((group) => keys.includes(group.key)).flatMap((group) => group.clips);
      expect(checkClusterLimits(clips, config).valid).toBe(true);
    }
  });

  it("5. two different events close in time are not merged", () => {
    const first = [single("driveway", "13:00:00", "13:00:20"), single("doorbell", "13:00:01", "13:00:20")];
    const second = [single("driveway", "13:00:25", "13:00:50"), single("doorbell", "13:00:26", "13:00:51")];
    expect(cluster([...first, ...second]).clusters).toEqual([keysOf(...first), keysOf(...second)]);
  });

  it("6. consecutive clips of the same camera are never grouped, not even indirectly", () => {
    // Garden records two overlapping files at the same time (e.g. two streams); Doorbell fits both.
    const garden1 = single("garden", "13:00:00", "13:01:00");
    const garden2 = single("garden", "13:00:01", "13:01:01");
    const doorbell = single("doorbell", "13:00:00", "13:01:00");
    const result = cluster([garden1, garden2, doorbell]);
    expect(result.clusters).toEqual([keysOf(garden1, doorbell)]);
  });

  it("8. clips without camera are never grouped", () => {
    const a = single(null, "13:01:05", "13:02:18");
    const b = single(null, "13:01:04", "13:02:18");
    const c = single("doorbell", "13:01:04", "13:02:18");
    expect(cluster([a, b, c]).clusters).toEqual([]);
  });

  it("respects metadata conflicts inside a cluster (A person, B nothing, C vehicle)", () => {
    const a = withMeta(clip("a", "13:00:00", "13:01:00"), meta(["person"], "13:00:05", "13:00:15"));
    const b = withMeta(clip("b", "13:00:01", "13:01:00"));
    const c = withMeta(clip("c", "13:00:01", "13:01:01"), meta(["vehicle"], "13:00:05", "13:00:15"));
    const groups = [a, b, c].map((x): FallbackGroup => ({ key: `g-${x.id}`, clips: [x], cameraIds: [x.cameraId!] }));
    const result = clusterTemporalFallback({ groups, existingPairs: [], candidatePairs: allPairs(groups), config });
    expect(result.clusters).toEqual([keysOf(groups[0], groups[1])]);
    expect(result.candidatePairsRejectedByMetadata).toBeGreaterThan(0);
  });

  it("never joins a group with two clips of one camera", () => {
    const x = withMeta(clip("a", "13:00:00", "13:01:00"));
    const y = withMeta(clip("a", "13:01:00", "13:02:00"));
    const twoFiles: FallbackGroup = { key: "g-two", clips: [x, y], cameraIds: ["a"] };
    const other = single("b", "13:00:00", "13:01:00");
    expect(cluster([twoFiles, other]).clusters).toEqual([]);
  });

  it("does not join a group whose Protect events come from a camera already in the cluster", () => {
    // Group 1: Doorbell clip + a Protect event of Garden (pendingClip side), group 2: a Garden clip.
    const k = withMeta(clip("doorbell", "13:00:00", "13:01:00"));
    const g = withMeta(clip("garden", "13:00:00", "13:01:00"));
    const result = clusterTemporalFallback({
      groups: [
        { key: "g-1", clips: [k], cameraIds: ["doorbell", "garden"] },
        { key: "g-2", clips: [g], cameraIds: ["garden"] },
      ],
      existingPairs: [],
      candidatePairs: [[k.id, g.id]],
      config,
    });
    expect(result.clusters).toEqual([]);
  });

  it("keeps an existing, still valid grouping although a new clip would also fit", () => {
    // Existing: B + C. New: A fits B but not C (start 6 s apart) – B stays with C.
    const a = single("a", "13:00:00", "13:01:00");
    const b = single("b", "13:00:03", "13:01:03");
    const c = single("c", "13:00:06", "13:01:06");
    const result = cluster([a, b, c], [[b.key, c.key]]);
    expect(result.clusters).toEqual([keysOf(b, c)]);
    expect(result.existingPairsRejected).toBe(0);
    // Without the existing grouping, the earliest pair wins.
    expect(cluster([a, b, c]).clusters).toEqual([keysOf(a, b)]);
  });

  it("drops an existing grouping that no longer holds", () => {
    const a = withMeta(clip("a", "13:00:00", "13:01:00"), meta(["person"], "13:00:05", "13:00:15"));
    const b = withMeta(clip("b", "13:00:00", "13:01:00"), meta(["vehicle"], "13:00:05", "13:00:15"));
    const groups = [a, b].map((x): FallbackGroup => ({ key: `g-${x.id}`, clips: [x], cameraIds: [x.cameraId!] }));
    const result = clusterTemporalFallback({ groups, existingPairs: [[groups[0].key, groups[1].key]], candidatePairs: [], config });
    expect(result).toMatchObject({ clusters: [], existingPairsRejected: 1 });
  });

  it("is deterministic regardless of input order", () => {
    const groups = ["a", "b", "c", "d", "e"].map((camera, i) => single(camera, `13:00:0${i}`, `13:01:0${i}`));
    const pairs = allPairs(groups);
    const forward = clusterTemporalFallback({ groups, existingPairs: [], candidatePairs: pairs, config });
    const backward = clusterTemporalFallback({
      groups: groups.toReversed(),
      existingPairs: [],
      candidatePairs: pairs.toReversed().map(([x, y]): [string, string] => [y, x]),
      config,
    });
    expect(backward.clusters).toEqual(forward.clusters);
  });
});
