import "server-only";

import path from "node:path";

import { createFfmpegRunner } from "./ffmpeg-runner";
import { consoleMediaLogger } from "./media-logger";
import { THUMBNAIL_DEFAULTS, ThumbnailService } from "./thumbnail-service";

/**
 * Media configuration from the environment, read when a media request needs it – never at
 * import or build time (the build works without ffmpeg, NAS and cache directory).
 *
 * - FFMPEG_PATH: ffmpeg binary (default `ffmpeg` from PATH).
 * - THUMBNAIL_CACHE_ROOT: writable directory for thumbnails, outside ARCHIVE_ROOT
 *   (default `.cache/thumbnails` in the working directory, for development).
 * - THUMBNAIL_MAX_CONCURRENCY: parallel ffmpeg processes (default 2, 1–16).
 */

export interface MediaConfig {
  ffmpegPath: string;
  thumbnailCacheRoot: string;
  thumbnailMaxConcurrency: number;
}

export class MediaConfigError extends Error {
  override name = "MediaConfigError";
}

export function readMediaConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): MediaConfig {
  const ffmpegPath = env.FFMPEG_PATH?.trim() || "ffmpeg";
  const cacheRaw = env.THUMBNAIL_CACHE_ROOT?.trim() || path.join(".cache", "thumbnails");
  if (cacheRaw.includes("\0")) throw new MediaConfigError("THUMBNAIL_CACHE_ROOT contains a NUL byte.");
  const concurrencyRaw = env.THUMBNAIL_MAX_CONCURRENCY?.trim();
  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : THUMBNAIL_DEFAULTS.maxConcurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new MediaConfigError(`THUMBNAIL_MAX_CONCURRENCY must be an integer from 1 to 16, got “${concurrencyRaw}”.`);
  }
  return {
    ffmpegPath,
    thumbnailCacheRoot: path.resolve(cwd, cacheRaw),
    thumbnailMaxConcurrency: concurrency,
  };
}

// One service per process, kept on globalThis so development reloads do not create a second
// queue (which would double the ffmpeg limit and lose the de-duplication).
const SERVICE_KEY = Symbol.for("unifi-archive.thumbnail-service");
type GlobalWithService = typeof globalThis & { [SERVICE_KEY]?: ThumbnailService };

export function getThumbnailService(): ThumbnailService {
  const store = globalThis as GlobalWithService;
  if (!store[SERVICE_KEY]) {
    const config = readMediaConfig();
    store[SERVICE_KEY] = new ThumbnailService({
      cacheRoot: config.thumbnailCacheRoot,
      archiveRoot: process.env.ARCHIVE_ROOT,
      runner: createFfmpegRunner(config.ffmpegPath),
      maxConcurrency: config.thumbnailMaxConcurrency,
      logger: consoleMediaLogger,
    });
  }
  return store[SERVICE_KEY];
}
