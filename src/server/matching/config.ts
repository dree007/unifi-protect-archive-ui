/**
 * Tolerances of the reconciliation (docs/event-matching.md). Central defaults; the
 * reconciler accepts overrides (e.g. for tests), they are not read from the environment.
 */
export interface MatchingConfig {
  /** Max. gap between a Protect event and a clip of the same camera (default 5 s). */
  matchTimeToleranceMs: number;
  /** Max. gap between Protect events of different cameras to group them (default 3 s). */
  multiCameraGroupToleranceMs: number;
  /** Max. time span of all Protect events in one multi-camera group (default 30 s). */
  multiCameraMaxClusterSpanMs: number;
  /** Temporal fallback: max. difference of the clip starts (whole cluster, default 5 s). */
  temporalFallbackStartToleranceMs: number;
  /** Temporal fallback: max. difference of the clip ends (whole cluster, default 5 s). */
  temporalFallbackEndToleranceMs: number;
  /** Temporal fallback: min. intersection over union of the clip intervals (default 0.5). */
  temporalFallbackMinIou: number;
}

export const MATCH_TIME_TOLERANCE_MS = 5000;
export const MULTI_CAMERA_GROUP_TOLERANCE_MS = 3000;
export const MULTI_CAMERA_MAX_CLUSTER_SPAN_MS = 30_000;

// Temporal fallback for clips without (sufficient) Protect metadata, e.g. historic clips.
// Neighbouring cameras can start their
// recordings up to a few seconds apart, and short clips (10–15 s) rarely reach a high overlap
// ratio. The absolute start/end tolerances carry the rule; the IoU only rules out a short clip
// inside a much longer one. Cluster-wide checks keep it conservative.
export const TEMPORAL_FALLBACK_START_TOLERANCE_MS = 5000;
export const TEMPORAL_FALLBACK_END_TOLERANCE_MS = 5000;
export const TEMPORAL_FALLBACK_MIN_IOU = 0.5;

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  matchTimeToleranceMs: MATCH_TIME_TOLERANCE_MS,
  multiCameraGroupToleranceMs: MULTI_CAMERA_GROUP_TOLERANCE_MS,
  multiCameraMaxClusterSpanMs: MULTI_CAMERA_MAX_CLUSTER_SPAN_MS,
  temporalFallbackStartToleranceMs: TEMPORAL_FALLBACK_START_TOLERANCE_MS,
  temporalFallbackEndToleranceMs: TEMPORAL_FALLBACK_END_TOLERANCE_MS,
  temporalFallbackMinIou: TEMPORAL_FALLBACK_MIN_IOU,
};
