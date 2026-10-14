/**
 * Where to grab the preview frame, in milliseconds from the start of the clip. Pure.
 *
 * UniFi clips start with pre-roll, so the first frame rarely shows what triggered the
 * recording. ~22 % into the clip is usually the moment of interest. At least 0.5 s in (skips
 * a black/grey first frame), but never more than half of a very short clip, and always at
 * least 250 ms before the end so ffmpeg still finds a frame.
 */
export const THUMBNAIL_POSITION = 0.22;
const MIN_OFFSET_MS = 500;
const END_MARGIN_MS = 250;

export function selectThumbnailTimestamp(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const preferred = Math.max(durationMs * THUMBNAIL_POSITION, Math.min(MIN_OFFSET_MS, durationMs / 2));
  const latest = Math.max(0, durationMs - END_MARGIN_MS);
  return Math.round(Math.min(preferred, latest));
}
