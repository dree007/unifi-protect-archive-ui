/**
 * Domain values shared by database schema, backend and UI. Smart detection types are
 * deliberately not an enum here: Protect adds new ones, they are plain strings throughout.
 */

export const CAMERA_STATES = ["online", "offline"] as const;

/** Normalized camera state (`online` only if Protect reports CONNECTED). */
export type CameraState = (typeof CAMERA_STATES)[number];

/**
 * How an archive event relates to Protect metadata.
 * - `matched`: recording(s) linked to one or more Protect events
 * - `archiveOnly`: recording(s) without Protect metadata (e.g. historic clips)
 * - `pendingClip`: Protect event known, but no recording in the archive yet
 */
export const METADATA_STATUSES = ["matched", "archiveOnly", "pendingClip"] as const;

export type MetadataStatus = (typeof METADATA_STATUSES)[number];
