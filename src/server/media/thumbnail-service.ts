import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { mediaVersion } from "@/lib/media-urls";
import type { ClipMediaRow } from "@/server/queries/clips";

import { openArchiveFile, resolveRealArchiveRoot } from "./archive-file";
import { prepareCacheDirectory } from "./cache-root";
import { ConcurrencyLimiter } from "./concurrency";
import { buildThumbnailArgs, FFMPEG_INPUT_FD, FfmpegError, type FfmpegRunner } from "./ffmpeg-runner";
import type { MediaLogger } from "./media-logger";
import { selectThumbnailTimestamp } from "./thumbnail-timestamp";

/**
 * Preview images (JPEG) for archived clips, rendered on demand with ffmpeg and cached in
 * THUMBNAIL_CACHE_ROOT – never in the read-only archive.
 *
 * - Cache key = clip ID + file mtime + file size as recorded by the indexer, so a changed file
 *   gets a new thumbnail and a cache hit needs no NAS access at all. No cleanup (yet).
 * - One generation per key at a time in this process (in-flight promises are shared), and at
 *   most `maxConcurrency` ffmpeg processes overall; the rest wait in a FIFO queue.
 * - ffmpeg writes a temporary file in the cache directory, which is renamed into place
 *   (atomic on one file system) – readers never see half-written JPEGs. On failure the
 *   temporary file is removed.
 * - The source is opened once via `openArchiveFile` and handed to ffmpeg as file descriptor 3.
 * - Failed renders (broken file) are remembered briefly so a list of cards does not start
 *   ffmpeg over and over for the same file.
 */

export type ThumbnailErrorKind =
  /** Cache directory or ffmpeg not usable, ffmpeg timed out: a server problem (503). */
  | "unavailable"
  /** ffmpeg could not get a frame from this file (422). */
  | "failed";

/**
 * Concrete cause, for logs, `media:check` and the `X-Thumbnail-Error` response header (never
 * contains paths). Missing/unreadable source files are `ArchiveFileError`s instead.
 */
export type ThumbnailErrorReason =
  /** FFMPEG_PATH not found or not executable. */
  | "ffmpeg-missing"
  /** ffmpeg killed after the timeout. */
  | "ffmpeg-timeout"
  /** ffmpeg ran but produced no frame (broken or unsupported file). */
  | "no-frame"
  /** THUMBNAIL_CACHE_ROOT missing, not writable or inside ARCHIVE_ROOT. */
  | "cache-unavailable"
  /** Clip ID not usable as a cache key. */
  | "invalid-clip";

const REASON_KIND: Record<ThumbnailErrorReason, ThumbnailErrorKind> = {
  "ffmpeg-missing": "unavailable",
  "ffmpeg-timeout": "unavailable",
  "no-frame": "failed",
  "cache-unavailable": "unavailable",
  "invalid-clip": "failed",
};

export class ThumbnailError extends Error {
  override name = "ThumbnailError";
  readonly kind: ThumbnailErrorKind;
  constructor(
    readonly reason: ThumbnailErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = REASON_KIND[reason];
  }
}

export interface ThumbnailServiceOptions {
  /** Absolute; created if missing; must be writable and outside ARCHIVE_ROOT. */
  cacheRoot: string;
  archiveRoot: string | undefined;
  runner: FfmpegRunner;
  maxConcurrency?: number;
  timeoutMs?: number;
  maxWidth?: number;
  /** How long a failed render is remembered (no new ffmpeg run for that key). */
  failureTtlMs?: number;
  logger: MediaLogger;
  now?: () => number;
}

export interface ThumbnailFile {
  key: string;
  /** Absolute path in the cache (server-only). */
  path: string;
  /** Served from the cache without rendering. */
  cached: boolean;
}

export const THUMBNAIL_DEFAULTS = {
  maxConcurrency: 2,
  timeoutMs: 20_000,
  maxWidth: 640,
  failureTtlMs: 10 * 60_000,
} as const;

const SAFE_KEY = /^[0-9a-f-]{36}-[0-9a-z]+-[0-9a-z]+$/;

/** `<clip-id>-<mtime base36>-<size base36>`; also the cache file name (plus `.jpg`). */
export function thumbnailCacheKey(clip: Pick<ClipMediaRow, "id" | "fileModifiedAt" | "fileSizeBytes">): string {
  const key = `${clip.id.toLowerCase()}-${mediaVersion(clip.fileModifiedAt, clip.fileSizeBytes)}`;
  // Clip IDs come from the database as UUIDs; anything else must never become a file name.
  if (!SAFE_KEY.test(key)) throw new ThumbnailError("invalid-clip", "Unexpected clip ID for a thumbnail cache key.");
  return key;
}

export class ThumbnailService {
  private readonly limiter: ConcurrencyLimiter;
  private readonly inflight = new Map<string, Promise<ThumbnailFile>>();
  private readonly failures = new Map<string, { until: number; error: ThumbnailError }>();
  private cacheReady: Promise<string> | undefined;
  private readonly options: Required<Omit<ThumbnailServiceOptions, "archiveRoot">> & Pick<ThumbnailServiceOptions, "archiveRoot">;

  constructor(options: ThumbnailServiceOptions) {
    this.options = {
      maxConcurrency: THUMBNAIL_DEFAULTS.maxConcurrency,
      timeoutMs: THUMBNAIL_DEFAULTS.timeoutMs,
      maxWidth: THUMBNAIL_DEFAULTS.maxWidth,
      failureTtlMs: THUMBNAIL_DEFAULTS.failureTtlMs,
      now: Date.now,
      ...options,
    };
    this.limiter = new ConcurrencyLimiter(this.options.maxConcurrency);
  }

  /** Number of renders currently running / waiting (diagnostics and tests). */
  get load(): { running: number; queued: number; inflight: number } {
    return { running: this.limiter.running, queued: this.limiter.queued, inflight: this.inflight.size };
  }

  /**
   * Cache directory, checked once per process: absolute, created, writable, outside the
   * (real) ARCHIVE_ROOT. A failed check is retried on the next request.
   */
  private prepareCacheRoot(): Promise<string> {
    this.cacheReady ??= (async () => {
      let archiveRoot: string | undefined;
      try {
        archiveRoot = await resolveRealArchiveRoot(this.options.archiveRoot);
      } catch {
        archiveRoot = undefined; // Archive not mounted: rendering fails later anyway.
      }
      try {
        const real = await prepareCacheDirectory(this.options.cacheRoot, archiveRoot);
        await access(real, constants.W_OK);
        return real;
      } catch (error) {
        throw new ThumbnailError("cache-unavailable", `Thumbnail cache directory not usable: ${String(error)}`, { cause: error });
      }
    })();
    return this.cacheReady.catch((error: unknown) => {
      this.cacheReady = undefined;
      throw error;
    });
  }

  /** The cached thumbnail of a clip, rendering it first if necessary. */
  async get(clip: ClipMediaRow): Promise<ThumbnailFile> {
    const key = thumbnailCacheKey(clip);
    const cacheRoot = await this.prepareCacheRoot();
    const target = path.join(cacheRoot, `${key}.jpg`);
    if (await isNonEmptyFile(target)) return { key, path: target, cached: true };

    const failure = this.failures.get(key);
    if (failure && failure.until > this.options.now()) throw failure.error;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.limiter
        .run(async () => {
          // Someone else (another request, an earlier process) may have finished meanwhile.
          if (await isNonEmptyFile(target)) return { key, path: target, cached: true };
          await this.render(clip, key, cacheRoot, target);
          return { key, path: target, cached: false };
        })
        .catch((error: unknown) => {
          if (error instanceof ThumbnailError && error.kind === "failed") {
            this.failures.set(key, { until: this.options.now() + this.options.failureTtlMs, error });
          }
          throw error;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async render(clip: ClipMediaRow, key: string, cacheRoot: string, target: string): Promise<void> {
    const { logger } = this.options;
    const source = await openArchiveFile(this.options.archiveRoot, clip.filePath);
    const temp = path.join(cacheRoot, `.${key}.${process.pid}.${randomUUID()}.tmp.jpg`);
    const started = this.options.now();
    try {
      const timestampMs = selectThumbnailTimestamp(clip.durationMs);
      try {
        await this.renderFrame(source.handle.fd, timestampMs, temp);
      } catch (error) {
        // The recorded duration can be longer than the real stream: retry at the very start.
        if (!(error instanceof ThumbnailError && error.kind === "failed") || timestampMs === 0) throw error;
        await rm(temp, { force: true });
        await this.renderFrame(source.handle.fd, 0, temp);
      }
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      // File-specific failures are logged here (once: they are remembered for failureTtlMs).
      // Server-wide problems (ffmpeg missing, cache, timeouts) are logged by the endpoint,
      // throttled per reason, so a page of cards does not log the same problem 30 times.
      if (error instanceof ThumbnailError && error.kind === "failed") {
        logger.error(`clip ${clip.id}: thumbnail failed (${error.reason}) after ${this.options.now() - started} ms: ${error.message}`);
      }
      throw error;
    } finally {
      await source.close();
    }
  }

  private async renderFrame(inputFd: number, timestampMs: number, output: string): Promise<void> {
    const args = buildThumbnailArgs({ timestampMs, input: FFMPEG_INPUT_FD, output, maxWidth: this.options.maxWidth });
    try {
      await this.options.runner.run({ args, inputFd, timeoutMs: this.options.timeoutMs });
    } catch (error) {
      if (error instanceof FfmpegError) {
        const reason = { failed: "no-frame", unavailable: "ffmpeg-missing", timeout: "ffmpeg-timeout" } as const;
        throw new ThumbnailError(reason[error.kind], error.message, { cause: error });
      }
      throw error;
    }
    if (!(await isNonEmptyFile(output))) {
      throw new ThumbnailError("no-frame", `ffmpeg produced no frame at ${timestampMs} ms.`);
    }
  }
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  try {
    const stats = await stat(file);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}
