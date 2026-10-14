import type { Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

/**
 * Read-only discovery of the UniFi archive: ARCHIVE_ROOT/YYYY-MM-DD/*.mp4 (or
 * ARCHIVE_ROOT/UniFi-Protect_YYYY-MM-DD/*.mp4, as written by Protect's archive export).
 *
 * Only directory listings and file metadata (`lstat`) are read; files are never opened,
 * modified, moved or deleted. Symbolic links are ignored entirely, so traversal can never
 * leave ARCHIVE_ROOT, and only one level of day directories is visited (no recursion).
 */

const DAY_DIRECTORY = /^(?:UniFi-Protect_)?(\d{4}-\d{2}-\d{2})$/;
const MP4 = /\.mp4$/i;

/** The `YYYY-MM-DD` date of a day-directory name, or `undefined` if it is not one. */
export function dayDirectoryDate(name: string): string | undefined {
  return DAY_DIRECTORY.exec(name)?.[1];
}

/** A regular MP4 file inside a day directory. */
export interface DiscoveredFile {
  /** POSIX path relative to the archive root: `<dayDirectory>/<fileName>`. */
  relativePath: string;
  dayDirectory: string;
  /** Date of the day directory, `YYYY-MM-DD` (without a `UniFi-Protect_` prefix). */
  dayDate: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export type IgnoredReason = "notDayDirectory" | "notMp4" | "symlink" | "notRegularFile";

export type DiscoveryItem =
  | { kind: "dayDirectory"; name: string }
  | { kind: "file"; file: DiscoveredFile }
  | { kind: "ignored"; relativePath: string; reason: IgnoredReason }
  /** Metadata of a listed file could not be read; the scan continues. */
  | { kind: "fileError"; relativePath: string; code: string | undefined; message: string; presence: StatErrorPresence };

/**
 * What a failed `lstat` of a file that was just listed says about the file:
 * - `vanished`: it is gone (deleted or moved between listing and `lstat`),
 * - `unreadable`: it was listed, so it exists, but its metadata cannot be read.
 */
export type StatErrorPresence = "vanished" | "unreadable";

/**
 * Only ENOENT/ENOTDIR prove that the entry no longer exists. Every other error (EACCES, EPERM,
 * EIO, …) is treated as "exists but unreadable": wrongly calling a file gone would make a
 * present clip look missing, which is the worse mistake.
 */
export function classifyStatError(code: string | undefined): StatErrorPresence {
  return code === "ENOENT" || code === "ENOTDIR" ? "vanished" : "unreadable";
}

export interface DiscoveryOptions {
  /** Number of concurrent `lstat` calls within a directory (bounded, default 16). */
  statConcurrency?: number;
}

function classify(entry: Dirent): "directory" | "file" | "symlink" | "other" {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/**
 * Yields day directories, MP4 files and ignored entries of the archive. Directory listing
 * errors are fundamental (e.g. NAS connection lost) and are thrown; metadata errors of single
 * listed files are yielded as `fileError` (see {@link classifyStatError}).
 *
 * Memory stays bounded: day-directory names are collected (one per day), files are streamed.
 */
export async function* discoverArchive(
  root: string,
  { statConcurrency = 16 }: DiscoveryOptions = {},
): AsyncGenerator<DiscoveryItem> {
  const dayDirectories: { name: string; date: string }[] = [];
  for await (const entry of await opendir(root)) {
    const kind = classify(entry);
    const date = kind === "directory" ? dayDirectoryDate(entry.name) : undefined;
    if (date) {
      dayDirectories.push({ name: entry.name, date });
    } else {
      yield {
        kind: "ignored",
        relativePath: entry.name,
        reason: kind === "symlink" ? "symlink" : "notDayDirectory",
      };
    }
  }
  // Oldest day first: deterministic order, and progress is easy to follow.
  // Sorted by date, so prefixed and plain names of the same archive interleave correctly.
  dayDirectories.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  for (const { name: dayDirectory, date: dayDate } of dayDirectories) {
    yield { kind: "dayDirectory", name: dayDirectory };
    const directoryPath = path.join(root, dayDirectory);
    let batch: string[] = [];
    for await (const entry of await opendir(directoryPath)) {
      const relativePath = `${dayDirectory}/${entry.name}`;
      const kind = classify(entry);
      if (kind !== "file") {
        yield {
          kind: "ignored",
          relativePath,
          reason: kind === "symlink" ? "symlink" : "notRegularFile",
        };
      } else if (!MP4.test(entry.name)) {
        yield { kind: "ignored", relativePath, reason: "notMp4" };
      } else {
        batch.push(entry.name);
        if (batch.length >= statConcurrency) {
          yield* statBatch(directoryPath, dayDirectory, dayDate, batch);
          batch = [];
        }
      }
    }
    yield* statBatch(directoryPath, dayDirectory, dayDate, batch);
  }
}

async function* statBatch(
  directoryPath: string,
  dayDirectory: string,
  dayDate: string,
  fileNames: string[],
): AsyncGenerator<DiscoveryItem> {
  const results = await Promise.allSettled(fileNames.map((name) => lstat(path.join(directoryPath, name))));
  for (const [index, result] of results.entries()) {
    const fileName = fileNames[index];
    const relativePath = `${dayDirectory}/${fileName}`;
    if (result.status === "rejected") {
      const code = (result.reason as NodeJS.ErrnoException).code;
      yield {
        kind: "fileError",
        relativePath,
        code,
        message: `cannot read file metadata (${code ?? String(result.reason)})`,
        presence: classifyStatError(code),
      };
    } else if (!result.value.isFile()) {
      // Replaced by something else (e.g. a symlink) since the listing.
      yield { kind: "ignored", relativePath, reason: "notRegularFile" };
    } else {
      yield {
        kind: "file",
        file: {
          relativePath,
          dayDirectory,
          dayDate,
          fileName,
          sizeBytes: result.value.size,
          modifiedAt: result.value.mtime,
        },
      };
    }
  }
}
