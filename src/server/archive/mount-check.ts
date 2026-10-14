import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ArchiveRootError } from "./archive-root";

/**
 * Optional checks that the NAS is really mounted. Without them, an unmounted network share
 * often leaves an empty directory behind, which looks like an empty archive.
 *
 * - ARCHIVE_REQUIRED_MOUNT: the directory must be a mount point. Works for Linux network
 *   mounts on the host (listed in /proc/self/mountinfo); elsewhere a device-ID comparison with
 *   the parent directory is used. Useless inside a container: the Docker bind mount itself is
 *   always a mount point, even when the NAS is not mounted on the host.
 * - ARCHIVE_REQUIRED_FS_TYPE: the file system ARCHIVE_ROOT lies on must be of this type (e.g.
 *   `nfs4`, `cifs`). Works on the host and in containers: a bind mount reports the type of the
 *   file system behind it – `nfs4` while the NAS is mounted, the host's `ext4` once it is not.
 */

const unescapeMountField = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

/**
 * Entries of /proc/self/mountinfo: mount point (field 5, octal escapes such as `\040` decoded)
 * and file system type (first field after the ` - ` separator). Later lines win, like the kernel
 * shows stacked mounts.
 */
export function parseMountInfo(mountinfo: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    if (fields[4] && separator > 0 && fields[separator + 1]) {
      entries.push({ mountPoint: unescapeMountField(fields[4]), fsType: fields[separator + 1] });
    }
  }
  return entries;
}

/** Mount points from /proc/self/mountinfo. */
export function parseMountPoints(mountinfo: string): Set<string> {
  return new Set(parseMountInfo(mountinfo).map((entry) => entry.mountPoint));
}

/** The mount (last listed, longest mount point) that contains `directory` (absolute, real). */
export function findContainingMount(entries: MountEntry[], directory: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const entry of entries) {
    const relative = path.relative(entry.mountPoint, directory);
    const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (inside && (!best || entry.mountPoint.length >= best.mountPoint.length)) best = entry;
  }
  return best;
}

/**
 * Throws ArchiveRootError (scan fails, nothing marked missing) unless `directory` lies on a file
 * system of one of `fsTypes` (compared case-insensitively). Needs /proc/self/mountinfo (Linux,
 * containers); elsewhere the check fails closed.
 */
export async function assertFileSystemType(directory: string, fsTypes: readonly string[]): Promise<void> {
  let resolved: string;
  let mountinfo: string;
  try {
    resolved = await realpath(directory);
    mountinfo = await readFile("/proc/self/mountinfo", "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ArchiveRootError(`ARCHIVE_REQUIRED_FS_TYPE cannot be checked (${code ?? String(error)}); is the NAS mounted?`, {
      cause: error,
    });
  }
  const mount = findContainingMount(parseMountInfo(mountinfo), resolved);
  const wanted = fsTypes.map((type) => type.toLowerCase());
  if (!mount || !wanted.includes(mount.fsType.toLowerCase())) {
    throw new ArchiveRootError(
      `ARCHIVE_ROOT is on a "${mount?.fsType ?? "unknown"}" file system, expected ${fsTypes.join(" or ")} ` +
        "(ARCHIVE_REQUIRED_FS_TYPE): the NAS is not mounted (on the Docker host). Nothing was marked missing.",
    );
  }
}

/** ARCHIVE_REQUIRED_FS_TYPE: comma-separated file system types; blank → no check. */
export function parseFileSystemTypes(raw: string | undefined): string[] | null {
  const types = (raw ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  for (const type of types) {
    if (!/^[A-Za-z0-9._-]+$/.test(type)) throw new Error(`ARCHIVE_REQUIRED_FS_TYPE contains an invalid file system type: "${type}".`);
  }
  return types.length > 0 ? types : null;
}

export async function isMountPoint(directory: string): Promise<boolean> {
  const resolved = await realpath(directory);
  try {
    return parseMountPoints(await readFile("/proc/self/mountinfo", "utf8")).has(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // No /proc (e.g. macOS): a mount point lies on another device than its parent.
  const parent = path.dirname(resolved);
  if (parent === resolved) return true;
  const [own, above] = await Promise.all([stat(resolved), stat(parent)]);
  return own.dev !== above.dev;
}

/** Throws ArchiveRootError (scan fails, nothing marked missing) if `mountPoint` is not mounted. */
export async function assertMounted(mountPoint: string): Promise<void> {
  let mounted: boolean;
  try {
    mounted = await isMountPoint(mountPoint);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ArchiveRootError(`ARCHIVE_REQUIRED_MOUNT is not accessible (${code ?? String(error)}); is the NAS mounted?`, {
      cause: error,
    });
  }
  if (!mounted) {
    throw new ArchiveRootError("ARCHIVE_REQUIRED_MOUNT is not a mount point: the NAS is not mounted.");
  }
}
