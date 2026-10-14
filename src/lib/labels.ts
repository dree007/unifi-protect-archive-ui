import type { Translator } from "@/i18n/core";
import type { MetadataStatus } from "@/domain/types";
import type { GroupingKind } from "@/lib/view-models";

/** German labels of the detection types known today; others get a generic label. */
export const DETECTION_LABELS: Record<string, string> = {
  person: "Person",
  vehicle: "Fahrzeug",
  animal: "Tier",
  package: "Paket",
  face: "Gesicht",
  licensePlate: "Kennzeichen",
};

/** Label for any Protect detection type, e.g. `someNewType` → "Some new type". */
export function detectionLabel(type: string, t?: Translator): string {
  const key = Object.hasOwn(DETECTION_KEYS, type) ? DETECTION_KEYS[type as keyof typeof DETECTION_KEYS] : undefined;
  if (t && key) return t(key);
  const known = Object.hasOwn(DETECTION_LABELS, type) ? DETECTION_LABELS[type] : undefined;
  if (known) return known;
  const words = type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : type;
}

export const ARCHIVE_CLIP_LABEL = "Archivclip";

/** Human-friendly status names (the technical values are never shown). */
export const METADATA_STATUS_LABELS: Record<MetadataStatus, string> = {
  matched: "Erkennung",
  archiveOnly: "Archivclip",
  pendingClip: "Aufnahme ausstehend",
};

export const METADATA_STATUS_DESCRIPTIONS: Record<MetadataStatus, string> = {
  matched: "Aufnahme und Erkennung von UniFi Protect wurden einander zugeordnet.",
  archiveOnly: "Aufnahme aus dem NAS-Archiv, für die keine Erkennungsdaten von Protect vorliegen.",
  pendingClip: "Protect hat das Ereignis erkannt – die Aufnahme liegt noch nicht im Archiv.",
};

/** Why several cameras form one event (independent of the metadata status). */
export const GROUPING_LABELS: Record<GroupingKind, string> = {
  metadata: "Erkennungen abgeglichen",
  temporal: "Zeitlich zugeordnet",
};

export const GROUPING_DESCRIPTIONS: Record<GroupingKind, string> = {
  metadata: "Die Kameras wurden über übereinstimmende Erkennungen von UniFi Protect zusammengefasst.",
  temporal: "Diese Aufnahmen wurden aufgrund sehr ähnlicher Aufnahmezeiten zusammengefasst.",
};

export const DETECTION_KEYS = { person: "detections.person", vehicle: "detections.vehicle", animal: "detections.animal", package: "detections.package", face: "detections.face", licensePlate: "detections.licensePlate" } as const;
export const METADATA_STATUS_KEYS = { matched: "status.matched", archiveOnly: "status.archiveOnly", pendingClip: "status.pendingClip" } as const;
export const METADATA_DESCRIPTION_KEYS = { matched: "status.matchedDescription", archiveOnly: "status.archiveOnlyDescription", pendingClip: "status.pendingDescription" } as const;
export const GROUPING_KEYS = { metadata: "status.metadata", temporal: "status.temporal" } as const;
export const GROUPING_DESCRIPTION_KEYS = { metadata: "status.metadataDescription", temporal: "status.temporalDescription" } as const;
