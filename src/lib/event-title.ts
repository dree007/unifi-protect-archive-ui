import type { Translator } from "@/i18n/core";
import type { MetadataStatus } from "@/domain/types";

import { detectionLabel } from "./labels";

/** Headline of an event: "Person erkannt", otherwise by status ("Archivclip", "Aufnahme ausstehend"). */
export function eventTitle(event: { detectionTypes: readonly string[]; status: MetadataStatus }, t?: Translator): string {
  const [primary] = event.detectionTypes;
  if (primary) return t ? t("events.detected", { type: detectionLabel(primary, t) }) : `${detectionLabel(primary)} erkannt`;
  if (t) return t(event.status === "pendingClip" ? "events.pending" : "events.archiveClip");
  return event.status === "pendingClip" ? "Aufnahme ausstehend" : "Archivclip";
}
