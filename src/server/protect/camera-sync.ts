import "server-only";

import type { CameraState } from "@/domain/types";
import type { CameraRow } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { upsertCameras, type CameraInput, type CameraWriteOutcome } from "@/server/repositories/cameras";

import type { ProtectCamera } from "./payloads";
import type { ProtectHttpClient } from "./protect-http-client";

/** Normalized UI state: only `CONNECTED` is online; every other (also unknown) state is offline. */
export function toCameraState(protectState: string): CameraState {
  return protectState.toUpperCase() === "CONNECTED" ? "online" : "offline";
}

export function toCameraInput(camera: ProtectCamera, syncedAt: Date): CameraInput {
  const state = toCameraState(camera.state);
  return {
    protectDeviceId: camera.id,
    name: camera.name,
    state,
    protectState: camera.state,
    mac: camera.mac,
    smartDetectTypes: camera.smartDetectTypes,
    // "Last seen" = last sync that found the camera connected; kept otherwise.
    lastSeenAt: state === "online" ? syncedAt : null,
  };
}

export interface CameraSyncResult {
  received: number;
  /** Payload entries that could not be used (e.g. missing id); the sync continued. */
  invalid: { index: number; reason: string }[];
  counts: Record<CameraWriteOutcome, number>;
  cameras: { camera: CameraRow; outcome: CameraWriteOutcome }[];
}

/**
 * Reads all cameras from Protect and upserts them by Protect device ID (renames update the
 * same row). Cameras no longer reported by Protect are kept untouched. Fails as a whole if the
 * API call fails; single unusable entries are skipped and reported.
 */
export async function syncProtectCameras(
  client: Pick<ProtectHttpClient, "getCameras">,
  db: Database,
  now: () => Date = () => new Date(),
): Promise<CameraSyncResult> {
  const { cameras, invalid } = await client.getCameras();
  const received = cameras.length + invalid.length;

  // One row per device ID (a statement may not update the same row twice).
  const byId = new Map<string, ProtectCamera>();
  cameras.forEach((camera, index) => {
    if (byId.has(camera.id)) invalid.push({ index, reason: `duplicate camera id ${camera.id}` });
    byId.set(camera.id, camera);
  });

  const syncedAt = now();
  const results = await upsertCameras(
    [...byId.values()].map((camera) => toCameraInput(camera, syncedAt)),
    db,
  );
  const counts: Record<CameraWriteOutcome, number> = { inserted: 0, updated: 0, unchanged: 0 };
  for (const { outcome } of results) counts[outcome]++;
  results.sort((a, b) => a.camera.name.localeCompare(b.camera.name, "de"));
  return { received, invalid, counts, cameras: results };
}
