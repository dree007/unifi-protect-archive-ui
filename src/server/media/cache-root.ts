import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** `candidate` is `root` itself or below it. Both must be absolute and normalized. */
export function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Real path a (possibly not yet existing) directory would have: the deepest existing ancestor
 * resolved with realpath, plus the missing segments. Catches symlinked parents.
 */
async function prospectiveRealPath(directory: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(directory);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export class CacheRootError extends Error {
  override name = "CacheRootError";
}

/**
 * Validates and creates the thumbnail cache directory. The check against the (real)
 * ARCHIVE_ROOT happens BEFORE anything is created, so a misconfiguration can never create a
 * directory inside the archive. Returns the real path.
 */
export async function prepareCacheDirectory(cacheRoot: string, realArchiveRoot: string | undefined): Promise<string> {
  if (!path.isAbsolute(cacheRoot)) throw new CacheRootError("THUMBNAIL_CACHE_ROOT must be an absolute path.");
  const overlaps = (candidate: string) =>
    realArchiveRoot !== undefined && (isSameOrInside(realArchiveRoot, candidate) || isSameOrInside(candidate, realArchiveRoot));
  if (overlaps(await prospectiveRealPath(cacheRoot))) {
    throw new CacheRootError("THUMBNAIL_CACHE_ROOT must be outside ARCHIVE_ROOT (and must not contain it).");
  }
  await mkdir(cacheRoot, { recursive: true });
  const real = await realpath(cacheRoot);
  // Re-check after creation (a symlink could have appeared in between).
  if (overlaps(real)) throw new CacheRootError("THUMBNAIL_CACHE_ROOT must be outside ARCHIVE_ROOT (and must not contain it).");
  return real;
}
