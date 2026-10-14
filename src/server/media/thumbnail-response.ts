import { readFile } from "node:fs/promises";

import type { ClipMediaRow } from "@/server/queries/clips";

import { ArchiveFileError } from "./archive-file";
import type { MediaLogger } from "./media-logger";
import { BASE_MEDIA_HEADERS, matchesIfNoneMatch, mediaError } from "./media-response";
import { thumbnailCacheKey, ThumbnailError, type ThumbnailErrorReason, type ThumbnailFile } from "./thumbnail-service";
import { archiveErrorResponse } from "./video-response";

/**
 * `GET /api/clips/[clipId]/thumbnail?v=<version>`: the clip's preview JPEG.
 *
 * Every response uses no-store, regardless of the URL version or a server-side cache hit.
 * The persistent JPEG cache still avoids repeated ffmpeg work. Explicit If-None-Match
 * requests can receive a no-store 304; proxies must authorize these requests too.
 *
 * Status codes: 404 unknown clip or missing video file, 422 no frame could be extracted,
 * 503 archive/ffmpeg/cache not available or ffmpeg timed out. The UI shows a soft fallback for
 * every non-200 response. Thumbnail errors carry their cause in `X-Thumbnail-Error` (e.g.
 * `ffmpeg-missing`, `no-frame`; see ThumbnailErrorReason) for diagnosis in the browser's
 * network tab – never paths or details. Server-wide causes are logged at most once per
 * minute and reason.
 */

export interface ThumbnailRequestDeps {
  findClip(clipId: string): Promise<ClipMediaRow | undefined>;
  getThumbnail(clip: ClipMediaRow): Promise<ThumbnailFile>;
  logger: MediaLogger;
  /** For the log throttle (tests). */
  now?: () => number;
}

const LOG_THROTTLE_MS = 60_000;
const lastLogged = new Map<ThumbnailErrorReason | "unexpected", number>();

/** Logs a server-wide problem at most once per reason and minute (a card list requests many thumbnails). */
function logThrottled(deps: ThumbnailRequestDeps, reason: ThumbnailErrorReason | "unexpected", message: string): void {
  const now = (deps.now ?? Date.now)();
  const last = lastLogged.get(reason);
  if (last !== undefined && now - last < LOG_THROTTLE_MS) return;
  lastLogged.set(reason, now);
  deps.logger.error(`${message} (further “${reason}” errors suppressed for ${LOG_THROTTLE_MS / 1000} s)`);
}

/** Test helper: forget the throttle state. */
export function resetThumbnailLogThrottle(): void {
  lastLogged.clear();
}

export async function handleThumbnailRequest(request: Request, clipId: string, deps: ThumbnailRequestDeps): Promise<Response> {
  let clip: ClipMediaRow | undefined;
  try {
    clip = await deps.findClip(clipId);
  } catch (error) {
    deps.logger.error(`clip ${clipId}: database lookup failed: ${String(error)}`);
    return mediaError(503, "database-unavailable");
  }
  if (!clip) return mediaError(404, "clip-not-found");

  let key: string;
  try {
    key = thumbnailCacheKey(clip);
  } catch {
    return mediaError(422, "thumbnail-failed", { headers: { "X-Thumbnail-Error": "invalid-clip" } });
  }
  const etag = `"${key}"`;
  const headers = {
    ...BASE_MEDIA_HEADERS,
    ETag: etag,
  };
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let image: Buffer;
  try {
    const thumbnail = await deps.getThumbnail(clip);
    image = await readFile(thumbnail.path);
  } catch (error) {
    if (error instanceof ArchiveFileError) return archiveErrorResponse(error, clip.id, deps.logger, false);
    if (error instanceof ThumbnailError) {
      const headers = { "X-Thumbnail-Error": error.reason };
      // File-specific failures were logged by the service (once per file).
      if (error.kind === "failed") return mediaError(422, "thumbnail-failed", { headers });
      logThrottled(deps, error.reason, `thumbnails unavailable (${error.reason}), e.g. clip ${clip.id}: ${error.message}`);
      return mediaError(503, "thumbnail-unavailable", { headers });
    }
    logThrottled(deps, "unexpected", `clip ${clip.id}: unexpected thumbnail error: ${String(error)}`);
    return mediaError(503, "thumbnail-unavailable", { headers: { "X-Thumbnail-Error": "unexpected" } });
  }

  return new Response(new Uint8Array(image), {
    status: 200,
    headers: { ...headers, "Content-Type": "image/jpeg", "Content-Length": String(image.byteLength) },
  });
}
