import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFfmpegRunner, ffmpegVersion } from "@/server/media/ffmpeg-runner";
import { silentMediaLogger } from "@/server/media/media-logger";
import { ThumbnailError, ThumbnailService } from "@/server/media/thumbnail-service";
import type { ClipMediaRow } from "@/server/queries/clips";

/**
 * Integration test with the real ffmpeg binary (FFMPEG_PATH or `ffmpeg` from PATH).
 * Skipped where ffmpeg is not installed – unless REQUIRE_FFMPEG=1 (set in CI, which installs
 * ffmpeg), so the test can never be skipped silently there.
 */
const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const version = await ffmpegVersion(FFMPEG);
const required = process.env.REQUIRE_FFMPEG === "1";

if (required && !version) {
  throw new Error(`REQUIRE_FFMPEG=1, but “${FFMPEG} -version” does not run. Install ffmpeg or set FFMPEG_PATH.`);
}

/** Width and height from a JPEG's SOF marker. */
function jpegSize(data: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < data.length) {
    if (data[offset] !== 0xff) throw new Error("not a JPEG");
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("no SOF marker");
}

describe.runIf(version)(`thumbnails with real ffmpeg (${version ?? "not installed"})`, () => {
  let base: string;
  let archiveRoot: string;
  let service: ThumbnailService;
  const run = promisify(execFile);

  /** Synthetic MP4 (moov at the end, like a plain recording); H.264 unless `codec` is given. */
  async function makeVideo(name: string, size: string, seconds: number, codec: string[] = []) {
    const target = path.join(archiveRoot, "2026-03-29", name);
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=15:duration=${seconds}`,
      ...codec, "-pix_fmt", "yuv420p", "-y", target,
    ]);
    const stats = await stat(target);
    return {
      id: randomUUID(),
      filePath: `2026-03-29/${name}`,
      fileSizeBytes: stats.size,
      fileModifiedAt: stats.mtime,
      durationMs: seconds * 1000,
    } satisfies ClipMediaRow;
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "unifi-archive-ffmpeg-"));
    archiveRoot = path.join(base, "archive");
    await mkdir(path.join(archiveRoot, "2026-03-29"), { recursive: true });
    service = new ThumbnailService({
      cacheRoot: path.join(base, "cache"),
      archiveRoot,
      runner: createFfmpegRunner(FFMPEG),
      logger: silentMediaLogger,
    });
  }, 60_000);

  afterAll(() => rm(base, { recursive: true, force: true }));

  it("renders a 640 px wide JPEG keeping the aspect ratio, then serves it from the cache", async () => {
    const clip = await makeVideo("Driveway 1.01.05pm GMT+2 – Größe.mp4", "1280x720", 4);
    let started = performance.now();
    const first = await service.get(clip);
    const firstMs = performance.now() - started;
    expect(first.cached).toBe(false);
    const data = await readFile(first.path);
    expect(data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(jpegSize(data)).toEqual({ width: 640, height: 360 });

    started = performance.now();
    const second = await service.get(clip);
    const hitMs = performance.now() - started;
    expect(second.cached).toBe(true);
    console.info(`[ffmpeg test] first thumbnail ${firstMs.toFixed(0)} ms, cache hit ${hitMs.toFixed(1)} ms`);
    expect(await readdir(path.dirname(first.path))).toEqual([path.basename(first.path)]);
  }, 60_000);

  it("keeps 4:3 sources 4:3 and does not upscale small ones", async () => {
    const doorbell = await makeVideo("Doorbell.mp4", "1600x1200", 2);
    expect(jpegSize(await readFile((await service.get(doorbell)).path))).toEqual({ width: 640, height: 480 });
    const small = await makeVideo("Klein.mp4", "320x240", 2);
    expect(jpegSize(await readFile((await service.get(small)).path))).toEqual({ width: 320, height: 240 });
  }, 60_000);

  it("falls back to the first frame when the recorded duration is too long", async () => {
    const clip = await makeVideo("Kurz.mp4", "640x360", 1);
    const thumbnail = await service.get({ ...clip, durationMs: 120_000 }); // 26 s – beyond the end
    expect(jpegSize(await readFile(thumbnail.path)).width).toBe(640);
  }, 60_000);

  it("renders H.265 (HEVC) sources", async (context) => {
    const { stdout } = await run(FFMPEG, ["-hide_banner", "-encoders"]);
    if (!stdout.includes("libx265")) context.skip("this ffmpeg has no HEVC encoder to create the test video");
    const clip = await makeVideo("Garden HEVC.mp4", "1280x720", 2, ["-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1"]);
    const data = await readFile((await service.get(clip)).path);
    expect(data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(jpegSize(data)).toEqual({ width: 640, height: 360 });
  }, 60_000);

  it("renders parallel requests once and serves all of them", async () => {
    const clip = await makeVideo("Parallel.mp4", "640x360", 2);
    const results = await Promise.all(Array.from({ length: 6 }, () => service.get(clip)));
    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect(results.filter((result) => !result.cached).length).toBeGreaterThanOrEqual(1);
    expect(jpegSize(await readFile(results[0].path)).width).toBe(640);
  }, 60_000);

  it("fails cleanly for a truncated MP4 (recording cut off)", async () => {
    const whole = await makeVideo("Ganz.mp4", "640x360", 2);
    const data = await readFile(path.join(archiveRoot, whole.filePath));
    const target = path.join(archiveRoot, "2026-03-29", "abgeschnitten.mp4");
    await writeFile(target, data.subarray(0, Math.floor(data.length / 2))); // moov atom missing
    const stats = await stat(target);
    const error = await service
      .get({ id: randomUUID(), filePath: "2026-03-29/abgeschnitten.mp4", fileSizeBytes: stats.size, fileModifiedAt: stats.mtime, durationMs: 2000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThumbnailError);
    expect((error as ThumbnailError).reason).toBe("no-frame");
  }, 60_000);

  it("fails cleanly for a broken file and leaves no temporary files", async () => {
    const target = path.join(archiveRoot, "2026-03-29", "kaputt.mp4");
    await writeFile(target, Buffer.alloc(4096, 7));
    const stats = await stat(target);
    const error = await service
      .get({ id: randomUUID(), filePath: "2026-03-29/kaputt.mp4", fileSizeBytes: stats.size, fileModifiedAt: stats.mtime, durationMs: 5000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThumbnailError);
    expect((error as ThumbnailError).kind).toBe("failed");
    expect((error as ThumbnailError).reason).toBe("no-frame");
    const leftovers = (await readdir(path.join(base, "cache"))).filter((name) => name.startsWith("."));
    expect(leftovers).toEqual([]);
  }, 60_000);
});
