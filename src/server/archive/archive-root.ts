import { stat } from "node:fs/promises";
import path from "node:path";

/** A fundamental problem with the archive root: the scan cannot run at all. */
export class ArchiveRootError extends Error {
  override name = "ArchiveRootError";
}

/**
 * Validates ARCHIVE_ROOT at the moment a scan actually runs (never at import/build time):
 * set, absolute, existing, a directory. Returns the normalized absolute path.
 */
export async function resolveArchiveRoot(raw: string | undefined): Promise<string> {
  const value = raw?.trim();
  if (!value) {
    throw new ArchiveRootError("ARCHIVE_ROOT is not set. Set it to the absolute path of the mounted UniFi archive.");
  }
  if (!path.isAbsolute(value)) {
    throw new ArchiveRootError(`ARCHIVE_ROOT must be an absolute path, got “${value}”.`);
  }
  const root = path.resolve(value);
  let stats;
  try {
    stats = await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ArchiveRootError(
      code === "ENOENT"
        ? `ARCHIVE_ROOT “${root}” does not exist (is the NAS mounted?).`
        : `ARCHIVE_ROOT “${root}” is not accessible (${code ?? String(error)}).`,
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new ArchiveRootError(`ARCHIVE_ROOT “${root}” is not a directory.`);
  }
  return root;
}
