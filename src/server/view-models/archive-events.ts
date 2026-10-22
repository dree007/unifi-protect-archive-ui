import type { MetadataStatus } from "@/domain/types";
import type { DateFormat } from "@/lib/date-format";
import { fileName } from "@/lib/format";
import { clipThumbnailUrl, clipVideoUrl, mediaVersion } from "@/lib/media-urls";
import type {
  CameraRef,
  ClipModel,
  ClipPreviewModel,
  EventCardModel,
  EventDetailModel,
  GroupingKind,
  GroupingPartModel,
  ProtectEventModel,
} from "@/lib/view-models";

/**
 * Pure mapping from database rows to the archive view models. No database access, no clock:
 * `now` and the date format (APP_TIME_ZONE) are passed in.
 */

export interface EventRow {
  id: string;
  startAt: Date;
  endAt: Date | null;
  status: MetadataStatus;
}

export interface EventClipRow {
  eventId: string;
  /** Primary group of the link (docs/event-matching.md); several per event = temporal fallback. */
  primaryGroupId: string;
  clipId: string;
  cameraId: string | null;
  /** Current camera name, or the name from the file name if the camera is not resolved. */
  cameraName: string;
  filePath: string;
  fileSizeBytes: number | null;
  /** File mtime recorded by the indexer; versions the thumbnail URL. */
  fileModifiedAt: Date | null;
  startAt: Date;
  endAt: Date;
  durationMs: number;
  /** Curation rows of this clip; the event aggregates them (docs/web-ui.md, "Favorites and collections"). */
  favorite: boolean;
  collectionIds: string[];
  /** Not found by the latest completed archive scan: the file is gone from the NAS. */
  missing: boolean;
}

export interface EventProtectRow {
  eventId: string;
  primaryGroupId: string;
  protectEventId: string;
  eventType: string;
  cameraId: string | null;
  /** `null` if the Protect device is not a known camera. */
  cameraName: string | null;
  smartDetectTypes: string[];
  startAt: Date;
  endAt: Date | null;
}

export interface FormatContext {
  format: DateFormat;
  now: Date;
}

const UNKNOWN_CAMERA = "Unbekannte Kamera";

/** Distinct cameras of an event: resolved cameras by ID, unresolved clips by their file name camera. */
export function eventCameras(clips: readonly EventClipRow[], protectEvents: readonly EventProtectRow[]): CameraRef[] {
  const cameras = new Map<string, CameraRef>();
  for (const clip of clips) {
    const key = clip.cameraId ?? `name:${clip.cameraName}`;
    if (!cameras.has(key)) cameras.set(key, { key, name: clip.cameraName });
  }
  for (const event of protectEvents) {
    if (event.cameraId && !cameras.has(event.cameraId)) {
      cameras.set(event.cameraId, { key: event.cameraId, name: event.cameraName ?? UNKNOWN_CAMERA, ...(!event.cameraName ? { unknown: true } : {}) });
    }
  }
  return [...cameras.values()].sort((a, b) => a.name.localeCompare(b.name, "de") || a.key.localeCompare(b.key));
}

/** All detection types of the event's Protect events, in first-seen order (by event start). */
export function eventDetectionTypes(protectEvents: readonly EventProtectRow[]): string[] {
  const types = new Set<string>();
  [...protectEvents]
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .forEach((event) => event.smartDetectTypes.forEach((type) => types.add(type)));
  return [...types];
}

/**
 * Why the cameras of an event belong together (only for events with several cameras): one
 * primary group = by Protect detections ("metadata"); several = joined by the temporal fallback
 * ("temporal"). `parts` lists the primary groups, earliest first, each with its cameras and
 * whether Protect reported it – so a mixed event never claims every camera was confirmed.
 * Independent of the metadata status.
 */
export function eventGrouping(
  clips: readonly EventClipRow[],
  protectEvents: readonly EventProtectRow[],
): { kind: GroupingKind | null; parts: GroupingPartModel[] } {
  if (eventCameras(clips, protectEvents).length < 2) return { kind: null, parts: [] };
  const groups = new Map<string, { start: number; cameras: Map<string, string>; confirmed: boolean }>();
  const groupOf = (id: string, startAt: Date) => {
    const group = groups.get(id) ?? { start: startAt.getTime(), cameras: new Map<string, string>(), confirmed: false };
    group.start = Math.min(group.start, startAt.getTime());
    groups.set(id, group);
    return group;
  };
  for (const clip of clips) groupOf(clip.primaryGroupId, clip.startAt).cameras.set(clipCameraKey(clip), clip.cameraName);
  for (const event of protectEvents) {
    const group = groupOf(event.primaryGroupId, event.startAt);
    group.confirmed = true;
    if (event.cameraId) group.cameras.set(event.cameraId, event.cameraName ?? UNKNOWN_CAMERA);
  }
  const unknownIds = new Map<string, Set<string>>();
  for (const event of protectEvents) {
    if (!event.cameraId) continue;
    const ids = unknownIds.get(event.primaryGroupId) ?? new Set<string>();
    if (event.cameraName === null) ids.add(event.cameraId); else ids.delete(event.cameraId);
    unknownIds.set(event.primaryGroupId, ids);
  }
  const parts = [...groups]
    .sort(([keyA, a], [keyB, b]) => a.start - b.start || keyA.localeCompare(keyB))
    .map(([key, group]) => {
      const entries = [...group.cameras.entries()].sort(([, a], [, b]) => a.localeCompare(b, "de"));
      const unknownCameras = entries.flatMap(([id], index) => unknownIds.get(key)?.has(id) ? [index] : []);
      return { key, cameras: entries.map(([, name]) => name), confirmed: group.confirmed, ...(unknownCameras.length ? { unknownCameras } : {}) };
    });
  return { kind: parts.length > 1 ? "temporal" : "metadata", parts };
}

const byClipStart = (a: EventClipRow, b: EventClipRow) =>
  a.startAt.getTime() - b.startAt.getTime() || a.cameraName.localeCompare(b.cameraName, "de") || a.clipId.localeCompare(b.clipId);

function clipCameraKey(clip: EventClipRow): string {
  return clip.cameraId ?? `name:${clip.cameraName}`;
}

function thumbnailUrl(clip: EventClipRow): string {
  return clipThumbnailUrl(clip.clipId, mediaVersion(clip.fileModifiedAt, clip.fileSizeBytes));
}

/**
 * Card previews: the earliest clip; if the clips come from exactly two cameras, the earliest
 * clip of each camera (shown side by side). Pending events have no clips and no previews.
 */
export function eventPreviews(clips: readonly EventClipRow[]): ClipPreviewModel[] {
  const firstPerCamera = new Map<string, EventClipRow>();
  for (const clip of [...clips].sort(byClipStart)) {
    if (!firstPerCamera.has(clipCameraKey(clip))) firstPerCamera.set(clipCameraKey(clip), clip);
  }
  const chosen = [...firstPerCamera.values()].slice(0, firstPerCamera.size === 2 ? 2 : 1);
  return chosen.map((clip) => ({ clipId: clip.clipId, cameraName: clip.cameraName, thumbnailUrl: thumbnailUrl(clip) }));
}

/**
 * Labels for the clip selection, unique within the event: the camera name alone if it has one
 * clip, otherwise with the start time ("Klingel · 13:01", with seconds if the minute repeats).
 * `clips` must already be in display order.
 */
export function clipLabels(clips: readonly EventClipRow[], format: DateFormat): string[] {
  const perCamera = new Map<string, number>();
  for (const clip of clips) perCamera.set(clip.cameraName, (perCamera.get(clip.cameraName) ?? 0) + 1);
  const withTime = clips.map((clip) =>
    (perCamera.get(clip.cameraName) ?? 0) > 1 ? `${clip.cameraName} · ${format.time(clip.startAt)}` : clip.cameraName,
  );
  const labels = clips.map((clip, index) =>
    withTime.filter((label) => label === withTime[index]).length > 1
      ? `${clip.cameraName} · ${format.timeWithSeconds(clip.startAt)}`
      : withTime[index],
  );
  // Last resort (same camera, same second): number them.
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count > 1 || labels.filter((other) => other === label).length > 1 ? `${label} (${count})` : label;
  });
}

export function toEventCardModel(
  event: EventRow,
  clips: readonly EventClipRow[],
  protectEvents: readonly EventProtectRow[],
  { format, now }: FormatContext,
): EventCardModel {
  return {
    id: event.id,
    presentation: { start: event.startAt.toISOString(), end: event.endAt?.toISOString() ?? null, now: now.toISOString(), timeZone: format.timeZone },
    dayKey: format.dayKey(event.startAt),
    dayLabel: format.dayLabel(event.startAt, now),
    dateLabel: format.date(event.startAt),
    timeLabel: format.time(event.startAt),
    whenLabel: format.eventTime(event.startAt, now),
    durationSeconds: event.endAt ? Math.round((event.endAt.getTime() - event.startAt.getTime()) / 1000) : null,
    detectionTypes: eventDetectionTypes(protectEvents),
    cameras: eventCameras(clips, protectEvents),
    status: event.status,
    clipCount: clips.length,
    protectEventCount: protectEvents.length,
    previews: eventPreviews(clips),
    grouping: eventGrouping(clips, protectEvents).kind,
    favorite: clips.some((clip) => clip.favorite),
  };
}

function toClipModel(clip: EventClipRow, label: string, format: DateFormat): ClipModel {
  return {
    id: clip.clipId,
    cameraName: clip.cameraName,
    label,
    fileName: fileName(clip.filePath),
    filePath: clip.filePath,
    directory: clip.filePath.includes("/") ? clip.filePath.slice(0, clip.filePath.lastIndexOf("/") + 1) : "",
    fileSizeBytes: clip.fileSizeBytes,
    startLabel: format.timeWithSeconds(clip.startAt),
    endLabel: format.timeWithSeconds(clip.endAt),
    start: clip.startAt.toISOString(),
    end: clip.endAt.toISOString(),
    durationSeconds: Math.round(clip.durationMs / 1000),
    videoUrl: clipVideoUrl(clip.clipId),
    thumbnailUrl: thumbnailUrl(clip),
    missing: clip.missing,
  };
}

function toProtectEventModel(event: EventProtectRow, format: DateFormat): ProtectEventModel {
  return {
    protectEventId: event.protectEventId,
    eventType: event.eventType,
    cameraName: event.cameraName ?? UNKNOWN_CAMERA,
    ...(!event.cameraName ? { unknownCamera: true } : {}),
    detectionTypes: event.smartDetectTypes,
    startLabel: format.timeWithSeconds(event.startAt),
    endLabel: event.endAt ? format.timeWithSeconds(event.endAt) : null,
  };
}

export function toEventDetailModel(
  event: EventRow,
  clips: readonly EventClipRow[],
  protectEvents: readonly EventProtectRow[],
  context: FormatContext,
): EventDetailModel {
  const byStart = <T extends { startAt: Date; cameraName: string | null }>(a: T, b: T) =>
    a.startAt.getTime() - b.startAt.getTime() || (a.cameraName ?? "").localeCompare(b.cameraName ?? "", "de");
  const sortedClips = [...clips].sort(byClipStart);
  const labels = clipLabels(sortedClips, context.format);
  return {
    ...toEventCardModel(event, clips, protectEvents, context),
    startLabel: context.format.dateTime(event.startAt),
    endLabel: event.endAt ? context.format.dateTime(event.endAt) : null,
    groupingParts: eventGrouping(clips, protectEvents).parts,
    clips: sortedClips.map((clip, index) => toClipModel(clip, labels[index], context.format)),
    protectEvents: [...protectEvents].sort(byStart).map((pe) => toProtectEventModel(pe, context.format)),
    collectionIds: [...new Set(clips.flatMap((clip) => clip.collectionIds))].sort(),
  };
}
