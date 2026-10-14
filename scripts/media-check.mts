// Checks what video playback and thumbnails need at runtime (docs/video-thumbnails.md):
//
//   npm run media:check
//   npm run media:check -- --clip-id <UUID>    additionally render that clip's real thumbnail
//
// - ARCHIVE_ROOT: set, absolute, a readable directory (read-only is expected and fine).
// - ffmpeg (FFMPEG_PATH): runs `ffmpeg -version`.
// - THUMBNAIL_CACHE_ROOT: created if missing, writable, outside ARCHIVE_ROOT.
// - --clip-id: looks the clip up in the database and gets its thumbnail through the same
//   ThumbnailService as the endpoint (cache hit or ffmpeg render), then checks the JPEG.
// Nothing is written to the archive. Exit codes: 0 all fine, 1 at least one problem, 2 usage.
import "./load-env.mts";

import { constants } from "node:fs";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { dayDirectoryDate } from "@/server/archive/filesystem-scanner";
import { getDb } from "@/server/db/client";
import { ArchiveFileError, resolveRealArchiveRoot } from "@/server/media/archive-file";
import { prepareCacheDirectory } from "@/server/media/cache-root";
import { ffmpegVersion } from "@/server/media/ffmpeg-runner";
import { getThumbnailService, readMediaConfig } from "@/server/media/media-config";
import { ThumbnailError } from "@/server/media/thumbnail-service";
import { getClipMedia, isClipId } from "@/server/queries/clips";

const USAGE = "Usage: npm run media:check -- [--clip-id <UUID>]";
let args;
try {
  args = parseArgs({ options: { "clip-id": { type: "string" }, help: { type: "boolean", short: "h", default: false } }, strict: true }).values;
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const clipId = args["clip-id"]?.trim();
if (clipId !== undefined && !isClipId(clipId)) {
  console.error(`--clip-id must be a clip UUID (e.g. from the browser's network tab: /api/clips/<UUID>/thumbnail).\n${USAGE}`);
  process.exit(2);
}

let problems = 0;
const ok = (label: string, detail: string) => console.log(`✔ ${label.padEnd(22)}${detail}`);
const fail = (label: string, detail: string) => {
  problems++;
  console.log(`✖ ${label.padEnd(22)}${detail}`);
};

let archiveRoot: string | undefined;
try {
  archiveRoot = await resolveRealArchiveRoot(process.env.ARCHIVE_ROOT);
  await access(archiveRoot, constants.R_OK | constants.X_OK);
  const days = (await readdir(archiveRoot)).filter((name) => dayDirectoryDate(name)).length;
  let writable = true;
  try {
    await access(archiveRoot, constants.W_OK);
  } catch {
    writable = false;
  }
  ok("ARCHIVE_ROOT", `${archiveRoot} (${days} day folders${writable ? ", WARNING: writable – mount it read-only" : ", read-only"})`);
} catch (error) {
  fail("ARCHIVE_ROOT", error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`.trim() : String(error));
}

let config;
try {
  config = readMediaConfig();
} catch (error) {
  fail("Configuration", error instanceof Error ? error.message : String(error));
}

if (config) {
  const version = await ffmpegVersion(config.ffmpegPath);
  if (version) ok("ffmpeg", `${config.ffmpegPath}: ${version}`);
  else fail("ffmpeg", `“${config.ffmpegPath} -version” does not run – install ffmpeg or set FFMPEG_PATH (thumbnails only; playback works without).`);

  try {
    // Checks the location against ARCHIVE_ROOT before creating anything.
    const cache = await prepareCacheDirectory(config.thumbnailCacheRoot, archiveRoot);
    const probe = path.join(cache, `.media-check-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    ok("THUMBNAIL_CACHE_ROOT", `${cache} (writable)`);
  } catch (error) {
    fail("THUMBNAIL_CACHE_ROOT", `${config.thumbnailCacheRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  ok("Concurrency", `${config.thumbnailMaxConcurrency} ffmpeg process(es)`);
}

if (clipId && config) await checkClipThumbnail(clipId);

/** Real thumbnail of one clip through the endpoint's ThumbnailService (same cache, same ffmpeg). */
async function checkClipThumbnail(id: string): Promise<void> {
  const db = getDb();
  try {
    let clip;
    try {
      clip = await getClipMedia(id, db);
    } catch (error) {
      fail("Clip lookup", `database not reachable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!clip) {
      fail("Clip lookup", `no archived clip with ID ${id}`);
      return;
    }
    ok("Clip lookup", `${clip.filePath} (${clip.fileSizeBytes ?? "?"} bytes, ${(clip.durationMs / 1000).toFixed(1)} s)`);
    const started = performance.now();
    try {
      const thumbnail = await getThumbnailService().get(clip);
      const data = await readFile(thumbnail.path);
      const isJpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      const how = thumbnail.cached ? "cache hit" : `rendered with ffmpeg in ${(performance.now() - started).toFixed(0)} ms`;
      if (isJpeg) ok("Thumbnail", `${how}: ${thumbnail.path} (${data.length} bytes JPEG)`);
      else fail("Thumbnail", `${thumbnail.path} is not a JPEG (${data.length} bytes) – delete it to render again`);
    } catch (error) {
      if (error instanceof ThumbnailError) fail("Thumbnail", `${error.reason}: ${error.message}`);
      else if (error instanceof ArchiveFileError) fail("Thumbnail", `source file ${error.kind}: ${error.message}`);
      else fail("Thumbnail", `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await db.$client.end().catch(() => {});
  }
}

process.exitCode = problems > 0 ? 1 : 0;
