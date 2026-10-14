import { Readable } from "node:stream";

import type { ClipMediaRow } from "@/server/queries/clips";

import { ArchiveFileError, openArchiveFile, type OpenArchiveFile } from "./archive-file";
import type { MediaLogger } from "./media-logger";
import { BASE_MEDIA_HEADERS, matchesIfNoneMatch, mediaError } from "./media-response";
import { parseRange } from "./range";

/**
 * `GET`/`HEAD /api/clips/[clipId]/video`: streams one archived MP4 with single byte-range
 * support. The browser only ever sends the clip ID; the file is looked up in the database and
 * opened via `openArchiveFile` (ARCHIVE_ROOT containment, no symlinks, one descriptor).
 *
 * - No `Range` → 200 with the whole file; one range → 206; anything else → 416.
 * - HEAD runs exactly the same logic (including a `Range`) and only drops the body.
 * - `ETag` = clip ID + size + mtime from fstat (no hashing), `Last-Modified` from mtime.
 *   `If-None-Match` → 304; `If-Range` that does not match → full 200 instead of 206.
 * - `Cache-Control: no-store` on all statuses, including HEAD, ranges, errors and explicit 304s.
 *   Seeking still streams directly from the descriptor; no complete-file buffering.
 * - Never touches the database or the archive beyond reading.
 */

export interface VideoRequestDeps {
  findClip(clipId: string): Promise<ClipMediaRow | undefined>;
  archiveRoot: string | undefined;
  logger: MediaLogger;
}

export function videoEtag(clipId: string, size: number, modifiedAt: Date): string {
  return `"${clipId}-${size.toString(16)}-${Math.trunc(modifiedAt.getTime()).toString(16)}"`;
}

function isAbort(error: NodeJS.ErrnoException): boolean {
  return (
    error.name === "AbortError" ||
    error.name === "ResponseAborted" || // Next.js, when the client goes away mid-response
    error.code === "ABORT_ERR" ||
    error.code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

/** `If-Range` holds if it equals our ETag (strong) or our Last-Modified date. */
function ifRangeHolds(header: string | null, etag: string, lastModified: string): boolean {
  if (header === null) return true;
  const value = header.trim();
  return value.startsWith('"') ? value === etag : value === lastModified;
}

/** Maps archive errors to responses; logs what an operator needs to know. */
export function archiveErrorResponse(
  error: unknown,
  clipId: string,
  logger: MediaLogger,
  head: boolean,
): Response {
  if (!(error instanceof ArchiveFileError)) {
    logger.error(`clip ${clipId}: unexpected error while opening the video: ${String(error)}`);
    return mediaError(500, "video-unavailable", { head });
  }
  switch (error.kind) {
    case "invalid-path":
    case "outside-root":
      // Security event: the stored path or the file system is not what the indexer saw.
      logger.warn(`clip ${clipId}: rejected archive path (${error.kind}): ${error.message}`);
      return mediaError(404, "video-unavailable", { head });
    case "not-found":
    case "not-a-file":
      logger.warn(`clip ${clipId}: video file missing (${error.kind})`);
      return mediaError(404, "video-unavailable", { head });
    case "archive-unavailable":
      logger.error(`clip ${clipId}: archive not available: ${String(error.cause ?? error.message)}`);
      return mediaError(503, "archive-unavailable", { head });
    case "access-denied":
      // Permission problem: report generically, never treat the file as deleted.
      logger.error(`clip ${clipId}: ${error.message}`);
      return mediaError(503, "video-unavailable", { head });
    case "io":
      logger.error(`clip ${clipId}: ${error.message}`);
      return mediaError(503, "video-unavailable", { head });
  }
}

export async function handleVideoRequest(request: Request, clipId: string, deps: VideoRequestDeps): Promise<Response> {
  const head = request.method === "HEAD";

  let clip: ClipMediaRow | undefined;
  try {
    clip = await deps.findClip(clipId);
  } catch (error) {
    deps.logger.error(`clip ${clipId}: database lookup failed: ${String(error)}`);
    return mediaError(503, "database-unavailable", { head });
  }
  if (!clip) return mediaError(404, "clip-not-found", { head });

  let file: OpenArchiveFile;
  try {
    file = await openArchiveFile(deps.archiveRoot, clip.filePath);
  } catch (error) {
    return archiveErrorResponse(error, clip.id, deps.logger, head);
  }

  let handedOff = false;
  try {
    const { size, modifiedAt } = file;
    const etag = videoEtag(clip.id, size, modifiedAt);
    const lastModified = modifiedAt.toUTCString();
    const common = {
      ...BASE_MEDIA_HEADERS,
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": lastModified,
    };

    if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: common });
    }

    const rangeHeader = ifRangeHolds(request.headers.get("if-range"), etag, lastModified)
      ? request.headers.get("range")
      : null;
    const range = parseRange(rangeHeader, size);
    if (range.kind === "unsatisfiable") {
      return mediaError(416, "range-not-satisfiable", {
        head,
        headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` },
      });
    }

    const start = range.kind === "single" ? range.start : 0;
    const end = range.kind === "single" ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      ...common,
      "Content-Type": "video/mp4",
      "Content-Length": String(length),
    };
    if (range.kind === "single") headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    const status = range.kind === "single" ? 206 : 200;

    if (head || length === 0) return new Response(null, { status, headers });

    // Streams from the already open descriptor; the stream closes it when done or cancelled.
    const stream = file.handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", (error: NodeJS.ErrnoException) => {
      // The browser cancelling a request (seeking, switching clips) is normal, not an error.
      if (isAbort(error)) return;
      deps.logger.error(`clip ${clip.id}: read error while streaming (${error.code ?? error.name}): ${error.message}`);
    });
    // A client that disconnects before the body is consumed would otherwise leave the
    // descriptor open until garbage collection: close it as soon as the request is aborted.
    const abort = () => stream.destroy();
    if (request.signal.aborted) abort();
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    handedOff = true;
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } finally {
    if (!handedOff) await file.close();
  }
}
