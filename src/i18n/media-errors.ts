import type { MediaErrorCode } from "@/server/media/media-response";
import type { MessageKey, Translator } from "./core";

const ERROR_KEYS = {
  "clip-not-found": "errors.clipNotFound",
  "video-unavailable": "errors.videoUnavailable",
  "archive-unavailable": "errors.archiveUnavailable",
  "database-unavailable": "errors.archiveDatabaseUnavailable",
  "range-not-satisfiable": "errors.rangeUnavailable",
  "thumbnail-failed": "errors.thumbnailFailed",
  "thumbnail-unavailable": "errors.thumbnailUnavailable",
} satisfies Record<MediaErrorCode, MessageKey>;

/** Only small JSON error bodies; successful media streams and HEAD responses are untouched. */
export async function localizeMediaError(response: Response, t: Translator): Promise<Response> {
  if (response.status < 400 || response.body === null) return response;
  const body = await response.json() as { error: MediaErrorCode; message: string };
  return Response.json({ ...body, message: t(ERROR_KEYS[body.error]) }, { status: response.status, headers: response.headers });
}
