/**
 * Temporal fallback (docs/event-matching.md): groups clips of different cameras that start
 * and end at almost the same time when Protect metadata cannot decide – typically historic
 * clips recorded before the Protect collector ran. Pure: no database, no clock.
 *
 * Three separate, separately tested layers:
 * - `calculateTemporalClipFallbackMatch`: camera + time only (two clips),
 * - `decideCrossCameraGrouping`: metadata priority (Protect metadata first, time second),
 * - `clusterTemporalFallback`: conservative clusters over whole metadata groups.
 */

import type { MatchingConfig } from "./config";
import { canGroupAcrossCameras, type DetectionInterval } from "./temporal-match";

export type TemporalFallbackConfig = Pick<
  MatchingConfig,
  | "temporalFallbackStartToleranceMs"
  | "temporalFallbackEndToleranceMs"
  | "temporalFallbackMinIou"
  | "multiCameraGroupToleranceMs"
>;

export interface FallbackClip {
  id: string;
  /** Resolved camera; `null` if the file-name camera could not be resolved unambiguously. */
  cameraId: string | null;
  startAt: Date;
  endAt: Date;
}

export type TemporalFallbackReason =
  | "matched"
  | "unknownCamera"
  | "sameCamera"
  | "invalidInterval"
  | "startTooFarApart"
  | "endTooFarApart"
  | "insufficientOverlap";

export interface TemporalClipFallbackMatch {
  isCandidate: boolean;
  /** |b.start − a.start| */
  startDeltaMs: number;
  /** |b.end − a.end| */
  endDeltaMs: number;
  /** Length of the overlap (0 if none). */
  overlapMs: number;
  /** Overlap / length of the union of both intervals (0 … 1). */
  intersectionOverUnion: number;
  reason: TemporalFallbackReason;
}

const validInterval = (clip: FallbackClip) => {
  const start = clip.startAt.getTime();
  const end = clip.endAt.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
};

/**
 * Time rule of the fallback for two clips: different, known cameras; valid intervals; starts at
 * most `temporalFallbackStartToleranceMs` apart, ends at most `temporalFallbackEndToleranceMs`
 * apart, and an intersection over union of at least `temporalFallbackMinIou`.
 * Metadata is not looked at here (see {@link decideCrossCameraGrouping}).
 */
export function calculateTemporalClipFallbackMatch(
  a: FallbackClip,
  b: FallbackClip,
  config: TemporalFallbackConfig,
): TemporalClipFallbackMatch {
  const result = (reason: TemporalFallbackReason, values: Partial<TemporalClipFallbackMatch> = {}) => ({
    isCandidate: reason === "matched",
    startDeltaMs: 0,
    endDeltaMs: 0,
    overlapMs: 0,
    intersectionOverUnion: 0,
    ...values,
    reason,
  });
  if (a.cameraId === null || b.cameraId === null) return result("unknownCamera");
  if (a.cameraId === b.cameraId) return result("sameCamera");
  if (!validInterval(a) || !validInterval(b)) return result("invalidInterval");

  const [aStart, aEnd, bStart, bEnd] = [a.startAt.getTime(), a.endAt.getTime(), b.startAt.getTime(), b.endAt.getTime()];
  const overlapMs = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const unionMs = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  const values = {
    startDeltaMs: Math.abs(bStart - aStart),
    endDeltaMs: Math.abs(bEnd - aEnd),
    overlapMs,
    intersectionOverUnion: overlapMs / unionMs,
  };
  if (values.startDeltaMs > config.temporalFallbackStartToleranceMs) return result("startTooFarApart", values);
  if (values.endDeltaMs > config.temporalFallbackEndToleranceMs) return result("endTooFarApart", values);
  if (values.intersectionOverUnion < config.temporalFallbackMinIou) return result("insufficientOverlap", values);
  return result("matched", values);
}

export interface ClusterLimits {
  valid: boolean;
  startSpanMs: number;
  endSpanMs: number;
  /** Intersection of all intervals / their union. */
  intersectionOverUnion: number;
  reason?: "invalidInterval" | "startTooFarApart" | "endTooFarApart" | "insufficientOverlap";
}

/**
 * Time rule for a whole cluster (not only neighbours): max(start) − min(start), max(end) −
 * min(end) and the IoU of all intervals together must stay within the fallback limits. This is
 * what keeps chains A–B–C–D (each only 2 s after the previous one) from growing.
 */
export function checkClusterLimits(clips: readonly FallbackClip[], config: TemporalFallbackConfig): ClusterLimits {
  if (clips.length === 0 || !clips.every(validInterval)) {
    return { valid: false, startSpanMs: 0, endSpanMs: 0, intersectionOverUnion: 0, reason: "invalidInterval" };
  }
  const starts = clips.map((clip) => clip.startAt.getTime());
  const ends = clips.map((clip) => clip.endAt.getTime());
  const startSpanMs = Math.max(...starts) - Math.min(...starts);
  const endSpanMs = Math.max(...ends) - Math.min(...ends);
  const intersection = Math.max(0, Math.min(...ends) - Math.max(...starts));
  const intersectionOverUnion = intersection / (Math.max(...ends) - Math.min(...starts));
  const limits = { startSpanMs, endSpanMs, intersectionOverUnion };
  if (startSpanMs > config.temporalFallbackStartToleranceMs) return { valid: false, ...limits, reason: "startTooFarApart" };
  if (endSpanMs > config.temporalFallbackEndToleranceMs) return { valid: false, ...limits, reason: "endTooFarApart" };
  if (intersectionOverUnion < config.temporalFallbackMinIou) return { valid: false, ...limits, reason: "insufficientOverlap" };
  return { valid: true, ...limits };
}

// --- metadata priority -----------------------------------------------------------------------

export interface ClipWithMetadata extends FallbackClip {
  /**
   * The Protect events that match exactly this clip (same camera, its time range; see
   * `isClipMatch`) – not every earlier detection of the camera.
   */
  protectEvents: readonly DetectionInterval[];
}

export type CrossCameraDecision =
  /** Both clips have usable Protect metadata and the metadata rule groups them. */
  | { method: "metadata" }
  /** Metadata cannot decide (missing on at least one side) and the time rule matches. */
  | { method: "temporalFallback"; temporal: TemporalClipFallbackMatch }
  | {
      method: "none";
      reason:
        | "unknownCamera"
        | "sameCamera"
        /** Both have detection types, but none in common (person vs. vehicle). */
        | "metadataConflict"
        /** Common detection type, but the metadata rule (e.g. 3 s between the events) fails. */
        | "metadataRuleNotMet"
        | Exclude<TemporalFallbackReason, "matched" | "unknownCamera" | "sameCamera">;
      temporal?: TemporalClipFallbackMatch;
    };

/** Protect events that say something about the class of the event (at least one detection type). */
const usable = (events: readonly DetectionInterval[]) => events.filter((event) => event.smartDetectTypes.length > 0);

/**
 * How two clips of different cameras may be grouped – metadata first, time second:
 * 1. Both clips have usable Protect metadata → the metadata rule alone decides
 *    (`canGroupAcrossCameras`): grouped, or not at all. The fallback never overrules it, also
 *    not when the clips are almost identical in time.
 * 2. Otherwise (no metadata, or only on one side) → the temporal fallback rule.
 * Detection types are compared as plain strings; unknown types are not discarded.
 */
export function decideCrossCameraGrouping(
  a: ClipWithMetadata,
  b: ClipWithMetadata,
  config: TemporalFallbackConfig,
): CrossCameraDecision {
  if (a.cameraId === null || b.cameraId === null) return { method: "none", reason: "unknownCamera" };
  if (a.cameraId === b.cameraId) return { method: "none", reason: "sameCamera" };

  const metadataA = usable(a.protectEvents);
  const metadataB = usable(b.protectEvents);
  if (metadataA.length > 0 && metadataB.length > 0) {
    if (metadataA.some((x) => metadataB.some((y) => canGroupAcrossCameras(x, y, config.multiCameraGroupToleranceMs)))) {
      return { method: "metadata" };
    }
    const typesB = new Set(metadataB.flatMap((event) => event.smartDetectTypes));
    const shared = metadataA.some((event) => event.smartDetectTypes.some((type) => typesB.has(type)));
    return { method: "none", reason: shared ? "metadataRuleNotMet" : "metadataConflict" };
  }

  const temporal = calculateTemporalClipFallbackMatch(a, b, config);
  if (temporal.reason === "matched") return { method: "temporalFallback", temporal };
  if (temporal.reason === "unknownCamera" || temporal.reason === "sameCamera") return { method: "none", reason: temporal.reason };
  return { method: "none", reason: temporal.reason, temporal };
}

// --- clusters ----------------------------------------------------------------------------------

/**
 * A metadata group ("primary group"): clips and Protect events that belong together by Protect
 * metadata, or a single clip. The fallback only ever joins whole groups, never splits one.
 */
export interface FallbackGroup {
  key: string;
  clips: readonly ClipWithMetadata[];
  /** Cameras of all clips and Protect events of the group. */
  cameraIds: readonly string[];
}

export interface TemporalClusterInput {
  groups: readonly FallbackGroup[];
  /**
   * Group pairs that are joined by the fallback today (same archive event). Re-checked first and
   * in the given order (the caller puts each event's own group first), so an existing, still
   * valid grouping is kept even if a new clip would fit "better".
   */
  existingPairs: readonly (readonly [string, string])[];
  /** Clip pairs from the candidate query (already narrowed by time and camera in SQL). */
  candidatePairs: readonly (readonly [string, string])[];
  config: TemporalFallbackConfig;
}

export interface TemporalClusterResult {
  /** Clusters of at least two groups (group keys sorted; clusters sorted by first key). */
  clusters: string[][];
  /** Existing pairs that no longer hold (their groups end up in different events). */
  existingPairsRejected: number;
  /** Candidate pairs whose clips are allowed to be grouped by time (pairwise). */
  candidatePairsMatched: number;
  /** … of these, refused because the whole cluster would break a rule. */
  candidatePairsRejectedByCluster: number;
  /** Candidate pairs refused because the Protect metadata contradicts or decides. */
  candidatePairsRejectedByMetadata: number;
}

/**
 * Groups eligible for the fallback: at least one clip, every clip with a known camera, and at
 * most one clip per camera (a group with two clips of one camera – e.g. one Protect event over
 * two consecutive files – is left alone; a time comparison would be ambiguous).
 */
function isEligible(group: FallbackGroup): boolean {
  const cameras = group.clips.map((clip) => clip.cameraId);
  return cameras.length > 0 && cameras.every((camera) => camera !== null) && new Set(cameras).size === cameras.length;
}

/**
 * Deterministic, conservative clustering of groups by the temporal fallback (union–find with a
 * check of the whole cluster on every union):
 * - every camera occurs in at most one group of a cluster (no indirect merging of different
 *   recordings of the same camera via a third clip),
 * - every clip pair of different groups must be a temporal fallback match by
 *   {@link decideCrossCameraGrouping} (a complete graph, not just a chain),
 * - start span, end span and IoU of all clips of the cluster stay within the limits.
 * Existing pairs come first, then the candidates (earliest first, then by IDs).
 */
export function clusterTemporalFallback({
  groups,
  existingPairs,
  candidatePairs,
  config,
}: TemporalClusterInput): TemporalClusterResult {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const groupOfClip = new Map<string, FallbackGroup>();
  for (const group of groups) for (const clip of group.clips) groupOfClip.set(clip.id, group);

  const parent = new Map<string, string>();
  const members = new Map<string, FallbackGroup[]>();
  for (const group of groups) {
    parent.set(group.key, group.key);
    members.set(group.key, [group]);
  }
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };

  type Refusal = "metadata" | "cluster";
  const tryUnion = (x: string, y: string): true | Refusal | "same" => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return "same";
    const left = members.get(rx)!;
    const right = members.get(ry)!;
    if (!left.every(isEligible) || !right.every(isEligible)) return "cluster";
    const leftCameras = new Set(left.flatMap((group) => group.cameraIds));
    if (right.some((group) => group.cameraIds.some((camera) => leftCameras.has(camera)))) return "cluster";
    for (const a of left.flatMap((group) => group.clips)) {
      for (const b of right.flatMap((group) => group.clips)) {
        const decision = decideCrossCameraGrouping(a, b, config);
        if (decision.method !== "temporalFallback") {
          return decision.method === "none" && (decision.reason === "metadataConflict" || decision.reason === "metadataRuleNotMet")
            ? "metadata"
            : "cluster";
        }
      }
    }
    if (!checkClusterLimits([...left, ...right].flatMap((group) => group.clips), config).valid) return "cluster";
    const [root, child] = rx < ry ? [rx, ry] : [ry, rx];
    parent.set(child, root);
    members.set(root, [...members.get(root)!, ...members.get(child)!]);
    members.delete(child);
    return true;
  };

  let existingPairsRejected = 0;
  const seen = new Set<string>();
  for (const [x, y] of existingPairs) {
    const key = x < y ? `${x} ${y}` : `${y} ${x}`;
    if (seen.has(key) || !byKey.has(x) || !byKey.has(y)) continue;
    seen.add(key);
    if (tryUnion(x, y) !== true && find(x) !== find(y)) existingPairsRejected++;
  }

  // Candidates: decided pairwise first, then applied in a fixed order (earliest first).
  const clipById = new Map(groups.flatMap((group) => group.clips.map((clip) => [clip.id, clip] as const)));
  let candidatePairsMatched = 0;
  let candidatePairsRejectedByCluster = 0;
  let candidatePairsRejectedByMetadata = 0;
  const matched: { a: ClipWithMetadata; b: ClipWithMetadata; startMs: number; key: string }[] = [];
  const sortedPairs = candidatePairs.map(([a, b]) => (a < b ? `${a} ${b}` : `${b} ${a}`)).toSorted();
  for (const pair of new Set(sortedPairs)) {
    const [x, y] = pair.split(" ");
    const a = clipById.get(x);
    const b = clipById.get(y);
    if (!a || !b) continue;
    if (groupOfClip.get(x) === groupOfClip.get(y)) continue; // already one metadata group
    const decision = decideCrossCameraGrouping(a, b, config);
    if (decision.method === "temporalFallback") {
      matched.push({ a, b, startMs: Math.min(a.startAt.getTime(), b.startAt.getTime()), key: pair });
    } else if (decision.method === "none" && (decision.reason === "metadataConflict" || decision.reason === "metadataRuleNotMet")) {
      candidatePairsRejectedByMetadata++;
    }
  }
  matched.sort((p, q) => p.startMs - q.startMs || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  for (const { a, b } of matched) {
    candidatePairsMatched++;
    const outcome = tryUnion(groupOfClip.get(a.id)!.key, groupOfClip.get(b.id)!.key);
    if (outcome === "metadata") candidatePairsRejectedByMetadata++;
    else if (outcome === "cluster") candidatePairsRejectedByCluster++;
  }

  const clusters = [...members.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.map((group) => group.key).toSorted())
    .toSorted((x, y) => (x[0] < y[0] ? -1 : 1));
  return {
    clusters,
    existingPairsRejected,
    candidatePairsMatched,
    candidatePairsRejectedByCluster,
    candidatePairsRejectedByMetadata,
  };
}
