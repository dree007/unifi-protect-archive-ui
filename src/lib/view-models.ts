import type { MetadataStatus } from "@/domain/types";

/**
 * Serializable view models: what the UI receives from the server. Built from database rows by
 * the mappers in src/server/view-models; never contain DB internals or secrets. Times are
 * already formatted in APP_TIME_ZONE (the browser's time zone is irrelevant).
 */

export interface CameraRef {
  unknown?: boolean;
  /** Camera ID, or `name:<camera name>` for clips whose camera is not resolved. */
  key: string;
  name: string;
}

export interface EventCardModel {
  /** Request clock and zone retained for relocalizing loaded pages without refetching. */
  presentation?: { start: string; end: string | null; now: string; timeZone: string };
  id: string;
  /** Calendar day in the app time zone, for grouping. */
  dayKey: string;
  /** "Heute", "Gestern", "Sonntag, 4. Oktober". */
  dayLabel: string;
  /** "06.10.2026" */
  dateLabel: string;
  /** "07:42" */
  timeLabel: string;
  /** "07:42" today, otherwise "Gestern, 21:14" / "04.10., 16:40". */
  whenLabel: string;
  /** `null` while ongoing. */
  durationSeconds: number | null;
  /** Any Protect detection types (unknown ones included). */
  detectionTypes: string[];
  /** Distinct cameras, in a stable order. */
  cameras: CameraRef[];
  status: MetadataStatus;
  clipCount: number;
  protectEventCount: number;
  /**
   * Preview images for the card: the earliest clip, or – if the clips come from exactly two
   * cameras – the earliest clip of each (split preview). Empty without clips (pending).
   */
  previews: ClipPreviewModel[];
  /**
   * Why several cameras form one event: `metadata` = matching Protect detections, `temporal` =
   * (also) joined by nearly identical recording times. `null` with a single camera.
   */
  grouping: GroupingKind | null;
  /** The event is a favorite (stored per clip: at least one of its clips is marked). */
  favorite: boolean;
}

export type GroupingKind = "metadata" | "temporal";

/** One primary group of an event: cameras that belong together by Protect metadata (or one clip). */
export interface GroupingPartModel {
  /** Indexes of generated labels, so actual user names are never translated. */
  unknownCameras?: number[];
  key: string;
  cameras: string[];
  /** Protect reported this part (it has Protect events); otherwise it was added by time only. */
  confirmed: boolean;
}

export interface ClipPreviewModel {
  clipId: string;
  cameraName: string;
  /** `/api/clips/<id>/thumbnail?v=<version>` – a clip ID, never a file system path. */
  thumbnailUrl: string;
}

export interface ArchivePageModel {
  events: EventCardModel[];
  /** Opaque cursor for the next page, `null` if this was the last one. */
  nextCursor: string | null;
}

export interface ClipModel {
  id: string;
  cameraName: string;
  /** Unique within the event: "Klingel", or "Klingel · 13:01" if the camera has several clips. */
  label: string;
  fileName: string;
  /** Relative to the archive root. */
  filePath: string;
  directory: string;
  fileSizeBytes: number | null;
  startLabel: string;
  endLabel: string;
  /** Recording start/end from the file name (ISO 8601), for synchronized playback. */
  start: string;
  end: string;
  durationSeconds: number;
  /** `/api/clips/<id>/video` */
  videoUrl: string;
  thumbnailUrl: string;
  /** The file was not found by the latest completed archive scan (no longer playable). */
  missing: boolean;
}

export interface ProtectEventModel {
  unknownCamera?: boolean;
  protectEventId: string;
  eventType: string;
  cameraName: string;
  detectionTypes: string[];
  startLabel: string;
  /** `null` while ongoing. */
  endLabel: string | null;
}

export interface EventDetailModel extends EventCardModel {
  /** "06.10.2026, 07:42:13" */
  startLabel: string;
  endLabel: string | null;
  /** Primary groups, earliest first; empty with a single camera. */
  groupingParts: GroupingPartModel[];
  clips: ClipModel[];
  protectEvents: ProtectEventModel[];
  /** Collections the event belongs to (at least one of its clips is in them). */
  collectionIds: string[];
}

export interface CameraViewModel {
  id: string;
  name: string;
  online: boolean;
  /** Raw Protect state, humanized ("Connected", "Firmware updating"); `null` if unknown. */
  protectStateLabel: string | null;
  protectDeviceId: string;
  mac: string | null;
  smartDetectTypes: string[];
  /** "vor 3 Tagen (03.10.2026, 07:00:00)" – last sync that saw it connected. */
  lastSeenLabel: string | null;
  clipCount: number;
  clipsToday: number;
  storageBytes: number;
  /** "vor 2 Minuten" */
  lastClipLabel: string | null;
}

export interface LatestDetectionModel {
  eventId: string;
  detectionTypes: string[];
  cameras: CameraRef[];
  relativeLabel: string;
  timeLabel: string;
}

export interface DashboardModel {
  /** Nothing indexed or received yet (fresh installation). */
  isEmpty: boolean;
  eventsToday: number;
  clipsTotal: number;
  archiveSizeBytes: number;
  camerasTotal: number;
  camerasOnline: number;
  latestDetection: LatestDetectionModel | null;
  /** "vor 42 Minuten", or `null` if no scan has completed yet. */
  lastScanLabel: string | null;
  lastScanFailed: boolean;
  recentEvents: EventCardModel[];
  /** Archive events per detection type in the last 7 days, most frequent first. */
  detections: { type: string; count: number }[];
}

export interface ScanRunModel {
  status: "running" | "completed" | "failed";
  startedLabel: string;
  finishedLabel: string | null;
  durationLabel: string | null;
  relativeLabel: string;
  filesFound: number;
  discovered: number;
  updated: number;
  unchanged: number;
  failed: number;
  warnings: number;
  /** Only known for completed runs. */
  missing: number | null;
  errorMessage: string | null;
}

export interface SystemStatusModel {
  databaseVersion: string;
  lastScan: ScanRunModel | null;
  /** The last completed scan, if the very last one did not complete. */
  lastCompletedScan: ScanRunModel | null;
  clipsTotal: number;
  archiveSizeBytes: number;
  eventsTotal: number;
  eventsByStatus: Record<MetadataStatus, number>;
  camerasTotal: number;
  camerasOnline: number;
  protectEventsTotal: number;
  /** Received time of the newest Protect message, e.g. "vor 3 Minuten". */
  lastProtectEventLabel: string | null;
  lastProtectEventDateTime: string | null;
  timeZone: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Operating state of the background worker and its components (system page). Derived from the
 * persisted status and the heartbeat age: a stored `running` alone proves nothing.
 */
export type WorkerStatusKind = "notStarted" | "starting" | "running" | "stopping" | "stopped" | "error" | "stale";
export type ProtectStatusKind =
  | "noStatus"
  | "disabled"
  | "notConfigured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "authenticationError"
  | "error"
  | "stopped"
  | "unknown";
export type JobStatusKind = "noStatus" | "idle" | "running" | "success" | "error" | "unknown";

export interface WorkerStatusModel {
  kind: WorkerStatusKind;
  /** Heartbeat fresh and the worker in operation: only then are component states current. */
  live: boolean;
  heartbeatLabel: string | null;
  startedLabel: string | null;
  stoppedLabel: string | null;
  errorMessage: string | null;
}

export interface ProtectStatusModel {
  kind: ProtectStatusKind;
  sinceLabel: string | null;
  lastConnectedLabel: string | null;
  cameraCount: number | null;
  errorMessage: string | null;
  lastErrorLabel: string | null;
}

export interface JobStatusModel {
  kind: JobStatusKind;
  lastStartedLabel: string | null;
  lastSucceededLabel: string | null;
  lastFailedLabel: string | null;
  nextRunLabel: string | null;
  /** Only for the current state `error`. */
  errorMessage: string | null;
}

export interface ReconciliationStatusModel extends JobStatusModel {
  durationLabel: string | null;
  eventsCreated: number | null;
  eventsMerged: number | null;
  eventsSplit: number | null;
  temporalFallbackEvents: number | null;
  multiCameraEvents: number | null;
}

export interface BackgroundStatusModel {
  worker: WorkerStatusModel;
  protect: ProtectStatusModel;
  scan: JobStatusModel;
  reconciliation: ReconciliationStatusModel;
  /** "vor 12 Sekunden"-style label of when the page data was read. */
  checkedAtLabel: string;
}
