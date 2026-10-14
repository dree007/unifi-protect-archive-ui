/**
 * Background components of the self-hosted worker (docs/background-worker.md) and their
 * persisted states. `stale` is never stored: it is derived from the heartbeat age.
 */

export const BACKGROUND_COMPONENTS = ["worker", "protect", "archiveScan", "reconciliation"] as const;
export type BackgroundComponent = (typeof BACKGROUND_COMPONENTS)[number];

export const WORKER_STATES = ["starting", "running", "stopping", "stopped", "error"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** `stopped`: the worker ended and closed the event stream on purpose. */
export const PROTECT_STATES = [
  "disabled",
  "connecting",
  "connected",
  "reconnecting",
  "authenticationError",
  "error",
  "stopped",
] as const;
export type ProtectState = (typeof PROTECT_STATES)[number];

/** NAS scan and reconciliation: `success`/`error` describe the last finished run. */
export const JOB_STATES = ["idle", "running", "success", "error"] as const;
export type JobState = (typeof JOB_STATES)[number];

export type BackgroundState = WorkerState | ProtectState | JobState;

/** Every value the `state` column accepts (union of the lists above). */
export const BACKGROUND_STATES: readonly BackgroundState[] = [
  ...new Set<BackgroundState>([...WORKER_STATES, ...PROTECT_STATES, ...JOB_STATES]),
];

/** Summary of the last successful reconciliation, kept in `details` (no separate runs table). */
export interface ReconciliationDetails {
  durationMs: number;
  clipsTotal: number;
  protectEventsTotal: number;
  clipEventMatches: number;
  archiveEventsCreated: number;
  archiveEventsMerged: number;
  archiveEventsSplit: number;
  multiCameraEvents: number;
  temporalFallbackEvents: number;
}

/** Facts of the event stream, kept in `details` of the `protect` row. */
export interface ProtectDetails {
  /** Why Protect is disabled: switched off, or simply not configured (auto). */
  disabledReason?: "switchedOff" | "notConfigured";
  /** Cameras received by the last successful camera sync. */
  cameraCount?: number;
}
