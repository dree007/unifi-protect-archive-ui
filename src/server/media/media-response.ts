/** Response helpers shared by the video and thumbnail endpoints. */

export type MediaErrorCode =
  | "clip-not-found"
  | "video-unavailable"
  | "archive-unavailable"
  | "database-unavailable"
  | "range-not-satisfiable"
  | "thumbnail-failed"
  | "thumbnail-unavailable";

/** Short German messages for the UI. Never contain paths, ARCHIVE_ROOT or error details. */
export const MEDIA_ERROR_MESSAGES: Record<MediaErrorCode, string> = {
  "clip-not-found": "Clip nicht gefunden",
  "video-unavailable": "Videodatei nicht verfügbar",
  "archive-unavailable": "Archiv derzeit nicht verfügbar",
  "database-unavailable": "Archivdatenbank derzeit nicht erreichbar",
  "range-not-satisfiable": "Angeforderter Bereich nicht verfügbar",
  "thumbnail-failed": "Vorschaubild konnte nicht erzeugt werden",
  "thumbnail-unavailable": "Vorschaubilder derzeit nicht verfügbar",
};

/** Private media must not be stored by browsers or shared proxies, including errors/304s.
 * This HTTP policy does not affect the persistent server-side thumbnail cache or static assets.
 */
export const PRIVATE_MEDIA_CACHE_CONTROL = "no-store";
export const BASE_MEDIA_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": PRIVATE_MEDIA_CACHE_CONTROL,
} as const;

export function mediaError(
  status: number,
  code: MediaErrorCode,
  options: { headers?: Record<string, string>; head?: boolean } = {},
): Response {
  const body = JSON.stringify({ error: code, message: MEDIA_ERROR_MESSAGES[code] });
  return new Response(options.head ? null : body, {
    status,
    headers: {
      ...BASE_MEDIA_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...options.headers,
    },
  });
}

/** Weak comparison of an `If-None-Match` header against our (strong) ETag. */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return value.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}
