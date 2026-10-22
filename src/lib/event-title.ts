import type { Translator } from "@/i18n/core";
import type { MetadataStatus } from "@/domain/types";

import { detectionLabel } from "./labels";

interface TitledEvent {
  detectionTypes: readonly string[];
  status: MetadataStatus;
  cameras?: readonly { name: string; unknown?: boolean }[];
}

/**
 * Headline of an event: "Person erkannt"; a pending recording says so; otherwise the cameras
 * ("Einfahrt + Klingel"), because "Archivclip" would be the same headline on nearly every event.
 */
export function eventTitle(event: TitledEvent, t?: Translator): string {
  const [primary] = event.detectionTypes;
  if (primary) return t ? t("events.detected", { type: detectionLabel(primary, t) }) : `${detectionLabel(primary)} erkannt`;
  if (event.status === "pendingClip") return t ? t("events.pending") : "Aufnahme ausstehend";
  const cameras = cameraTitle(event.cameras ?? [], t);
  if (cameras) return cameras;
  return t ? t("events.archiveClip") : "Archivclip";
}

/** True when the headline already names the cameras, so camera badges would only repeat it. */
export function titleNamesCameras(event: TitledEvent): boolean {
  return event.detectionTypes.length === 0 && event.status !== "pendingClip" && (event.cameras?.length ?? 0) > 0;
}

function cameraTitle(cameras: readonly { name: string; unknown?: boolean }[], t?: Translator): string {
  return cameras.map((camera) => camera.unknown ? (t ? t("cameras.unknown") : "Unbekannte Kamera") : camera.name).join(" + ");
}
