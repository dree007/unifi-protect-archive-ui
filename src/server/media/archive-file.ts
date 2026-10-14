import { constants } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { resolveArchiveRoot } from "@/server/archive/archive-root";

/**
 * The only way the application reaches a clip file on the NAS. Input is the clip's relative
 * `file_path` from the database (never anything the browser sends). The archive is opened
 * strictly read-only: resolve, open, fstat, read – nothing else.
 *
 * Rules:
 * - ARCHIVE_ROOT must be set, absolute, an existing directory (resolved with realpath).
 * - The relative path must be a plain POSIX path: no absolute paths, no `..`/`.`/empty
 *   segments, no backslashes, no NUL bytes. Unicode and spaces are fine.
 * - No symlinks anywhere below the root: neither the file nor a directory on the way. The
 *   indexer ignores symlinks as well, so a legitimate clip never has one.
 * - The file is opened once (O_RDONLY | O_NOFOLLOW); everything afterwards – size, mtime,
 *   streaming, ffmpeg input – uses that file descriptor. On Linux the descriptor's real path is
 *   re-checked via /proc, so swapping a directory between check and open cannot escape the root.
 */

export type ArchiveFileErrorKind =
  /** ARCHIVE_ROOT unset, not absolute, missing or not a directory (NAS not mounted). */
  | "archive-unavailable"
  /** The stored relative path is not acceptable (absolute, `..`, NUL, …). Security relevant. */
  | "invalid-path"
  /** A symlink on the way or a real path outside ARCHIVE_ROOT. Security relevant. */
  | "outside-root"
  /** The file does not exist (any more). */
  | "not-found"
  /** Exists, but is not a regular file (directory, device, …). */
  | "not-a-file"
  /** EACCES/EPERM: a permission problem, never a reason to consider the file deleted. */
  | "access-denied"
  /** Any other I/O error (EIO, ESTALE, …). */
  | "io";

export class ArchiveFileError extends Error {
  override name = "ArchiveFileError";
  constructor(
    readonly kind: ArchiveFileErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** Path violations are logged as security events. */
  get isViolation(): boolean {
    return this.kind === "invalid-path" || this.kind === "outside-root";
  }
}

const MAX_RELATIVE_PATH_LENGTH = 4096;

/**
 * Validates a stored relative archive path and returns its segments. Pure, no file system.
 * Throws `ArchiveFileError("invalid-path")`.
 */
export function validateRelativeArchivePath(relativePath: unknown): string[] {
  const fail = (reason: string) => {
    throw new ArchiveFileError("invalid-path", `Invalid archive path: ${reason}.`);
  };
  if (typeof relativePath !== "string" || relativePath.length === 0) fail("empty");
  const value = relativePath as string;
  if (value.length > MAX_RELATIVE_PATH_LENGTH) fail("too long");
  if (value.includes("\0")) fail("contains a NUL byte");
  if (value.includes("\\")) fail("contains a backslash");
  if (value.startsWith("/") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail("absolute path");
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") fail("empty, '.' or '..' segment");
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function fromErrno(error: unknown, what: string): ArchiveFileError {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new ArchiveFileError("not-found", `${what} not found.`, { cause: error });
    case "ELOOP":
      return new ArchiveFileError("outside-root", `${what} is a symbolic link.`, { cause: error });
    case "EACCES":
    case "EPERM":
      return new ArchiveFileError("access-denied", `${what} is not readable (${code}).`, { cause: error });
    default:
      return new ArchiveFileError("io", `${what} could not be read (${code ?? "unknown error"}).`, { cause: error });
  }
}

/** Real path of ARCHIVE_ROOT (validated, symlinks of the mount point itself resolved). */
export async function resolveRealArchiveRoot(rawRoot: string | undefined): Promise<string> {
  let root: string;
  try {
    root = await resolveArchiveRoot(rawRoot);
    return await realpath(root);
  } catch (error) {
    throw new ArchiveFileError("archive-unavailable", "The archive is not available.", { cause: error });
  }
}

export interface ResolvedArchiveFile {
  /** Real absolute path below the real ARCHIVE_ROOT. Server-only; never sent to a client. */
  realPath: string;
  realRoot: string;
}

/**
 * Resolves a stored relative path to a real path inside the real ARCHIVE_ROOT, without opening
 * it. Rejects symlinks (file and directories) and anything outside the root.
 */
export async function resolveArchiveFile(rawRoot: string | undefined, relativePath: string): Promise<ResolvedArchiveFile> {
  const segments = validateRelativeArchivePath(relativePath);
  const realRoot = await resolveRealArchiveRoot(rawRoot);
  // Runtime path below ARCHIVE_ROOT, nothing to trace at build time.
  const candidate = path.join(/*turbopackIgnore: true*/ realRoot, ...segments);
  if (!isInside(realRoot, candidate)) {
    throw new ArchiveFileError("outside-root", "Archive path leaves ARCHIVE_ROOT.");
  }

  // Not following the last component: a symlinked file is rejected even if it points inside.
  let stats;
  try {
    stats = await lstat(candidate);
  } catch (error) {
    throw fromErrno(error, "Archive file");
  }
  if (stats.isSymbolicLink()) throw new ArchiveFileError("outside-root", "Archive file is a symbolic link.");

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    throw fromErrno(error, "Archive file");
  }
  // Any symlinked directory on the way changes the real path.
  if (real !== candidate || !isInside(realRoot, real)) {
    throw new ArchiveFileError("outside-root", "Archive path contains a symbolic link or leaves ARCHIVE_ROOT.");
  }
  return { realPath: real, realRoot };
}

export interface OpenArchiveFile {
  handle: FileHandle;
  /** From fstat on the open descriptor. */
  size: number;
  modifiedAt: Date;
  /** Server-only, for logging and as ffmpeg's view of the input. */
  realPath: string;
  close(): Promise<void>;
}

/** Real path of an open descriptor (Linux), or `undefined` where /proc is not available. */
async function descriptorPath(fd: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/**
 * Resolves and opens an archive file read-only. The caller owns the handle and must close it
 * (or hand it to a stream with autoClose).
 */
export async function openArchiveFile(rawRoot: string | undefined, relativePath: string): Promise<OpenArchiveFile> {
  const { realPath, realRoot } = await resolveArchiveFile(rawRoot, relativePath);
  let handle: FileHandle;
  try {
    handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw fromErrno(error, "Archive file");
  }
  try {
    const opened = await descriptorPath(handle.fd);
    if (opened !== undefined && (opened !== realPath || !isInside(realRoot, opened))) {
      throw new ArchiveFileError("outside-root", "Archive file changed between check and open.");
    }
    let stats;
    try {
      stats = await handle.stat();
    } catch (error) {
      throw fromErrno(error, "Archive file");
    }
    if (!stats.isFile()) throw new ArchiveFileError("not-a-file", "Archive path is not a regular file.");
    let closed = false;
    return {
      handle,
      size: stats.size,
      modifiedAt: stats.mtime,
      realPath,
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
