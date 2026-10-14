/**
 * Pure matching rules: when may a Protect event be linked to a clip, and when may Protect
 * events of different cameras be grouped. Only camera, time and detection types are used.
 */

export interface TimeInterval {
  startAt: Date;
  /** `null` for an ongoing Protect event. */
  endAt: Date | null;
}

export interface TemporalMatch {
  /** Overlapping or at most `toleranceMs` apart. */
  isCandidate: boolean;
  /** Length of the overlap (0 if none). */
  overlapMs: number;
  /** Distance between the intervals (0 if they overlap or touch). */
  gapMs: number;
  /** b.start − a.start */
  startDeltaMs: number;
  /** b.end − a.end */
  endDeltaMs: number;
  /** Why it is not a candidate, if it is not. */
  reason?: "openInterval" | "invalidInterval" | "tooFarApart";
}

/**
 * Compares two time intervals. Open (ongoing) or inverted intervals are never candidates:
 * no end time is invented, and invalid data is not matched.
 */
export function calculateTemporalMatch(a: TimeInterval, b: TimeInterval, toleranceMs: number): TemporalMatch {
  const aStart = a.startAt.getTime();
  const bStart = b.startAt.getTime();
  if (a.endAt === null || b.endAt === null) {
    return { isCandidate: false, overlapMs: 0, gapMs: 0, startDeltaMs: bStart - aStart, endDeltaMs: 0, reason: "openInterval" };
  }
  const aEnd = a.endAt.getTime();
  const bEnd = b.endAt.getTime();
  const startDeltaMs = bStart - aStart;
  const endDeltaMs = bEnd - aEnd;
  if (aEnd < aStart || bEnd < bStart) {
    return { isCandidate: false, overlapMs: 0, gapMs: 0, startDeltaMs, endDeltaMs, reason: "invalidInterval" };
  }
  const overlapMs = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const gapMs = Math.max(0, Math.max(aStart, bStart) - Math.min(aEnd, bEnd));
  const isCandidate = gapMs <= toleranceMs;
  return { isCandidate, overlapMs, gapMs, startDeltaMs, endDeltaMs, ...(isCandidate ? {} : { reason: "tooFarApart" }) };
}

export interface CameraInterval extends TimeInterval {
  cameraId: string | null;
}

/** Clip ↔ Protect event: same (known) camera, closed Protect event, close enough in time. */
export function isClipMatch(clip: CameraInterval, protectEvent: CameraInterval, toleranceMs: number): boolean {
  if (clip.cameraId === null || clip.cameraId !== protectEvent.cameraId) return false;
  return calculateTemporalMatch(protectEvent, clip, toleranceMs).isCandidate;
}

export interface DetectionInterval extends CameraInterval {
  smartDetectTypes: readonly string[];
}

/**
 * Multi-camera rule for two Protect events: different known cameras, both with detection
 * types and at least one in common, both closed, and at most `toleranceMs` apart.
 * Time alone is never enough (person on one camera + vehicle on another stay separate).
 */
export function canGroupAcrossCameras(a: DetectionInterval, b: DetectionInterval, toleranceMs: number): boolean {
  if (a.cameraId === null || b.cameraId === null || a.cameraId === b.cameraId) return false;
  if (!a.smartDetectTypes.some((type) => b.smartDetectTypes.includes(type))) return false;
  return calculateTemporalMatch(a, b, toleranceMs).isCandidate;
}
