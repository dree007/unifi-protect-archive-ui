/**
 * URLs of the media endpoints. The browser only ever knows clip IDs – never ARCHIVE_ROOT or a
 * file system path.
 */

/**
 * Version of a clip's file as recorded by the indexer (mtime + size). Changes when the file
 * changes, so it versions thumbnail URLs and thumbnail cache keys. `x` for unknown values.
 */
export function mediaVersion(fileModifiedAt: Date | null, fileSizeBytes: number | null): string {
  const mtime = fileModifiedAt ? Math.trunc(fileModifiedAt.getTime()).toString(36) : "x";
  const size = fileSizeBytes !== null ? Math.trunc(fileSizeBytes).toString(36) : "x";
  return `${mtime}-${size}`;
}

export function clipVideoUrl(clipId: string): string {
  return `/api/clips/${encodeURIComponent(clipId)}/video`;
}

/** Versioned, so the browser may cache it for a long time (see thumbnail endpoint). */
export function clipThumbnailUrl(clipId: string, version: string): string {
  return `/api/clips/${encodeURIComponent(clipId)}/thumbnail?v=${encodeURIComponent(version)}`;
}
