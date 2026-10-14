import { randomUUID } from "node:crypto";
import { readSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clipThumbnailUrl, clipVideoUrl, mediaVersion } from "@/lib/media-urls";
import { ConcurrencyLimiter } from "@/server/media/concurrency";
import { createFfmpegRunner, FFMPEG_INPUT_FD, FfmpegError, type FfmpegJob, type FfmpegRunner } from "@/server/media/ffmpeg-runner";
import { readMediaConfig } from "@/server/media/media-config";
import { silentMediaLogger, type MediaLogger } from "@/server/media/media-logger";
import {
  handleThumbnailRequest,
  resetThumbnailLogThrottle,
} from "@/server/media/thumbnail-response";
import { thumbnailCacheKey, ThumbnailError, ThumbnailService, type ThumbnailServiceOptions } from "@/server/media/thumbnail-service";
import { selectThumbnailTimestamp } from "@/server/media/thumbnail-timestamp";
import type { ClipMediaRow } from "@/server/queries/clips";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const SOURCE = "fake mp4 content of the clip";

let base: string;
let archiveRoot: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "unifi-archive-thumbs-"));
  archiveRoot = path.join(base, "archive");
  await mkdir(path.join(archiveRoot, "2026-03-29"), { recursive: true });
  for (const name of ["a", "b", "c", "d", "e"]) {
    await writeFile(path.join(archiveRoot, "2026-03-29", `${name}.mp4`), `${SOURCE} ${name}`);
  }
});

afterAll(() => rm(base, { recursive: true, force: true }));

function clip(name = "a", overrides: Partial<ClipMediaRow> = {}): ClipMediaRow {
  return {
    id: randomUUID(),
    filePath: `2026-03-29/${name}.mp4`,
    fileSizeBytes: 1_234_567,
    fileModifiedAt: new Date("2026-03-29T11:02:18.000Z"),
    durationMs: 73_000,
    ...overrides,
  };
}

/** Fake ffmpeg: records jobs, reads the passed descriptor, writes a JPEG to the output path. */
class FakeRunner implements FfmpegRunner {
  jobs: (FfmpegJob & { source: string })[] = [];
  running = 0;
  maxRunning = 0;
  delayMs = 20;
  /** Called before writing; may throw or return "empty" (no output) / "partial" (then fail). */
  behaviour: (job: FfmpegJob, index: number) => "ok" | "empty" | "partial-fail" | "timeout" | "missing" = () => "ok";

  async run(job: FfmpegJob): Promise<void> {
    const buffer = Buffer.alloc(200);
    const read = readSync(job.inputFd!, buffer, 0, buffer.length, 0);
    this.jobs.push({ ...job, source: buffer.subarray(0, read).toString() });
    const index = this.jobs.length - 1;
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const output = job.args.at(-1)!.replace(/^file:/, "");
      switch (this.behaviour(job, index)) {
        case "ok":
          await writeFile(output, JPEG);
          return;
        case "empty":
          return;
        case "partial-fail":
          await writeFile(output, JPEG.subarray(0, 3));
          throw new FfmpegError("failed", "ffmpeg exited with 1: moov atom not found");
        case "timeout":
          throw new FfmpegError("timeout", "ffmpeg did not finish within 20000 ms");
        case "missing":
          throw new FfmpegError("unavailable", "ffmpeg not available (ENOENT); set FFMPEG_PATH");
      }
    } finally {
      this.running--;
    }
  }
}

async function setup(options: Partial<ThumbnailServiceOptions> = {}) {
  const cacheRoot = path.join(base, `cache-${randomUUID()}`);
  const runner = new FakeRunner();
  const service = new ThumbnailService({ cacheRoot, archiveRoot, runner, logger: silentMediaLogger, ...options });
  return { cacheRoot, runner, service, files: () => readdir(cacheRoot) };
}

describe("selectThumbnailTimestamp", () => {
  it("picks ~22 % into the clip, at least 0.5 s", () => {
    expect(selectThumbnailTimestamp(73_000)).toBe(16_060);
    expect(selectThumbnailTimestamp(10_000)).toBe(2_200);
    expect(selectThumbnailTimestamp(2_000)).toBe(500);
  });

  it("goes earlier for very short clips and never past the end", () => {
    expect(selectThumbnailTimestamp(800)).toBe(400);
    expect(selectThumbnailTimestamp(300)).toBe(50);
    expect(selectThumbnailTimestamp(200)).toBe(0);
    for (const duration of [1, 10, 100, 250, 251, 499, 500, 501, 999, 1000, 60_000, 3_600_000]) {
      const at = selectThumbnailTimestamp(duration);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(duration);
    }
  });

  it("falls back to the start for unknown durations", () => {
    expect(selectThumbnailTimestamp(0)).toBe(0);
    expect(selectThumbnailTimestamp(-5)).toBe(0);
    expect(selectThumbnailTimestamp(Number.NaN)).toBe(0);
  });
});

describe("cache key and URLs", () => {
  it("versions by mtime and size", () => {
    const c = clip();
    const key = thumbnailCacheKey(c);
    expect(key).toBe(`${c.id}-${mediaVersion(c.fileModifiedAt, c.fileSizeBytes)}`);
    expect(thumbnailCacheKey({ ...c, fileSizeBytes: 1 })).not.toBe(key);
    expect(thumbnailCacheKey({ ...c, fileModifiedAt: new Date("2026-03-30T00:00:00Z") })).not.toBe(key);
    expect(thumbnailCacheKey({ ...c, fileModifiedAt: null, fileSizeBytes: null })).toBe(`${c.id}-x-x`);
  });

  it("never turns anything but a UUID into a file name", () => {
    expect(() => thumbnailCacheKey({ ...clip(), id: "../../etc/passwd" })).toThrow(ThumbnailError);
  });

  it("builds URLs from clip IDs only", () => {
    expect(clipVideoUrl("abc")).toBe("/api/clips/abc/video");
    expect(clipThumbnailUrl("abc", "k-1")).toBe("/api/clips/abc/thumbnail?v=k-1");
  });
});

describe("ThumbnailService with a fake ffmpeg", () => {
  it("passes the right arguments and the opened source", async () => {
    const { runner, service, cacheRoot } = await setup();
    const c = clip("a");
    const result = await service.get(c);
    expect(result.cached).toBe(false);
    expect(result.path).toBe(path.join(cacheRoot, `${thumbnailCacheKey(c)}.jpg`));
    expect(runner.jobs).toHaveLength(1);
    const [job] = runner.jobs;
    expect(job.source).toBe(`${SOURCE} a`); // ffmpeg reads the descriptor we opened
    expect(job.args).toEqual(expect.arrayContaining(["-i", FFMPEG_INPUT_FD, "-frames:v", "1", "-nostdin"]));
    expect(job.args[job.args.indexOf("-ss") + 1]).toBe("16.060");
    expect(job.args[job.args.indexOf("-vf") + 1]).toBe("scale='min(640,iw)':-2");
    expect(job.args.indexOf("-ss")).toBeLessThan(job.args.indexOf("-i")); // fast input seeking
    const output = job.args.at(-1)!;
    expect(output.startsWith(`file:${cacheRoot}${path.sep}.`)).toBe(true); // temporary file in the cache
    expect(output).not.toBe(`file:${result.path}`);
    expect(job.args.join(" ")).not.toContain(archiveRoot); // no path into the archive at all
    expect(job.timeoutMs).toBe(20_000);
  });

  it("serves cache hits without starting ffmpeg", async () => {
    const { runner, service } = await setup();
    const c = clip("a");
    await service.get(c);
    const again = await service.get(c);
    expect(again.cached).toBe(true);
    expect(runner.jobs).toHaveLength(1);
  });

  it("starts only one ffmpeg for parallel requests of the same clip", async () => {
    const { runner, service } = await setup();
    const c = clip("a");
    const results = await Promise.all([service.get(c), service.get(c), service.get(c)]);
    expect(runner.jobs).toHaveLength(1);
    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    expect(service.load).toEqual({ running: 0, queued: 0, inflight: 0 });
  });

  it("limits concurrent ffmpeg processes and queues the rest", async () => {
    const { runner, service } = await setup({ maxConcurrency: 2 });
    await Promise.all(["a", "b", "c", "d", "e"].map((name) => service.get(clip(name))));
    expect(runner.jobs).toHaveLength(5);
    expect(runner.maxRunning).toBe(2);
  });

  it("renames atomically: the final file appears only complete, no temporary files remain", async () => {
    const { runner, service, files } = await setup();
    const c = clip("b");
    let finalDuringRun: string[] = [];
    runner.behaviour = () => "ok";
    const original = runner.run.bind(runner);
    runner.run = async (job) => {
      await original(job);
      finalDuringRun = (await files()).filter((name) => !name.startsWith("."));
    };
    await service.get(c);
    expect(finalDuringRun).toEqual([]); // written as temporary file first
    expect(await files()).toEqual([`${thumbnailCacheKey(c)}.jpg`]);
  });

  it("removes the temporary file when ffmpeg fails and remembers the failure briefly", async () => {
    let now = 1_000;
    const { runner, service, files } = await setup({ now: () => now, failureTtlMs: 60_000 });
    runner.behaviour = () => "partial-fail";
    const c = clip("c");
    const error = await service.get(c).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThumbnailError);
    expect((error as ThumbnailError).kind).toBe("failed");
    expect(runner.jobs).toHaveLength(2); // second try at 0 s
    expect(runner.jobs[1].args[runner.jobs[1].args.indexOf("-ss") + 1]).toBe("0.000");
    expect(await files()).toEqual([]);

    await expect(service.get(c)).rejects.toBeInstanceOf(ThumbnailError);
    expect(runner.jobs).toHaveLength(2); // remembered, no new process
    now += 60_001;
    runner.behaviour = () => "ok";
    await service.get(c);
    expect(runner.jobs).toHaveLength(3);
  });

  it("retries at the start when there is no frame at the chosen position", async () => {
    const { runner, service } = await setup();
    runner.behaviour = (_job, index) => (index === 0 ? "empty" : "ok");
    await service.get(clip("d"));
    expect(runner.jobs.map((job) => job.args[job.args.indexOf("-ss") + 1])).toEqual(["16.060", "0.000"]);
  });

  it("treats timeouts as temporary (503) and does not cache them", async () => {
    const { runner, service, files } = await setup();
    runner.behaviour = () => "timeout";
    const c = clip("a");
    const error = await service.get(c).catch((e: unknown) => e);
    expect((error as ThumbnailError).kind).toBe("unavailable");
    expect(runner.jobs).toHaveLength(1);
    expect(await files()).toEqual([]);
    runner.behaviour = () => "ok";
    await service.get(c);
    expect(runner.jobs).toHaveLength(2);
  });

  it("renders again when size or mtime change", async () => {
    const { runner, service, files } = await setup();
    const c = clip("a");
    await service.get(c);
    await service.get({ ...c, fileSizeBytes: c.fileSizeBytes! + 1 });
    await service.get({ ...c, fileModifiedAt: new Date("2026-04-01T00:00:00Z") });
    expect(runner.jobs).toHaveLength(3);
    expect(await files()).toHaveLength(3);
  });

  it("does not start ffmpeg for missing source files", async () => {
    const { runner, service } = await setup();
    const error = await service.get(clip("missing")).catch((e: unknown) => e);
    expect((error as { kind?: string }).kind).toBe("not-found");
    expect(runner.jobs).toHaveLength(0);
  });

  it("refuses a cache directory inside the archive without creating anything there", async () => {
    // Directly inside, and via a symlinked parent outside the archive that points into it.
    await symlink(archiveRoot, path.join(base, "archive-link"));
    for (const cacheRoot of [path.join(archiveRoot, "thumbnails", "new"), path.join(base, "archive-link", "thumbs"), archiveRoot, base]) {
      const { service, runner } = await setup({ cacheRoot });
      const error = await service.get(clip("a")).catch((e: unknown) => e);
      expect((error as ThumbnailError).kind, cacheRoot).toBe("unavailable");
      expect(runner.jobs).toHaveLength(0);
    }
    expect((await readdir(archiveRoot)).sort()).toEqual(["2026-03-29"]);
    expect((await readdir(path.join(archiveRoot, "2026-03-29"))).every((name) => name.endsWith(".mp4"))).toBe(true);
  });
});

describe("thumbnail endpoint", () => {
  async function endpoint(
    behaviour: FakeRunner["behaviour"] = () => "ok",
    { logger = silentMediaLogger, now, serviceOptions }: { logger?: MediaLogger; now?: () => number; serviceOptions?: Partial<ThumbnailServiceOptions> } = {},
  ) {
    resetThumbnailLogThrottle();
    const { service, runner } = await setup(serviceOptions);
    runner.behaviour = behaviour;
    const clips = new Map<string, ClipMediaRow>();
    const add = (c: ClipMediaRow) => (clips.set(c.id, c), c);
    const get = async (c: Pick<ClipMediaRow, "id">, query = "", headers: Record<string, string> = {}) => {
      const response = await handleThumbnailRequest(new Request(`http://localhost/api/clips/${c.id}/thumbnail${query}`, { headers }), c.id, {
        findClip: async (id) => clips.get(id),
        getThumbnail: (row) => service.get(row),
        logger,
        now,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response;
    };
    return { add, get, runner };
  }

  it("names the cause in X-Thumbnail-Error without leaking details", async () => {
    const cases = [
      { behaviour: () => "missing" as const, status: 503, reason: "ffmpeg-missing" },
      { behaviour: () => "timeout" as const, status: 503, reason: "ffmpeg-timeout" },
      { behaviour: () => "partial-fail" as const, status: 422, reason: "no-frame" },
      { behaviour: () => "empty" as const, status: 422, reason: "no-frame" },
    ];
    for (const { behaviour, status, reason } of cases) {
      const { add, get } = await endpoint(behaviour);
      const response = await get(add(clip("a")));
      expect(response.status, reason).toBe(status);
      expect(response.headers.get("x-thumbnail-error"), reason).toBe(reason);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain(base);
      expect(body).not.toContain("ENOENT");
    }
  });

  it.skipIf(process.getuid?.() === 0)("reports a non-writable cache directory as cache-unavailable", async () => {
    const cacheRoot = path.join(base, `readonly-cache-${randomUUID()}`);
    await mkdir(cacheRoot);
    await chmod(cacheRoot, 0o500);
    try {
      const { add, get, runner } = await endpoint(() => "ok", { serviceOptions: { cacheRoot } });
      const response = await get(add(clip("a")));
      expect(response.status).toBe(503);
      expect(response.headers.get("x-thumbnail-error")).toBe("cache-unavailable");
      expect(runner.jobs).toHaveLength(0);
    } finally {
      await chmod(cacheRoot, 0o700);
    }
  });

  it("logs a server-wide problem once per minute instead of once per card", async () => {
    const lines: string[] = [];
    const logger: MediaLogger = { warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    let now = 1_000_000;
    const { add, get } = await endpoint(() => "missing", { logger, now: () => now });
    for (const name of ["a", "b", "c", "d", "e"]) expect((await get(add(clip(name)))).status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ffmpeg-missing");
    now += 61_000;
    await get(add(clip("a")));
    expect(lines).toHaveLength(2);
  });

  it("does not log successful requests", async () => {
    const lines: string[] = [];
    const logger: MediaLogger = { warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const { add, get, runner } = await endpoint(() => "ok", { logger });
    const c = add(clip("a"));
    for (let i = 0; i < 2; i++) {
      const response = await get(c);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(runner.jobs).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("serves a JPEG with no-store for current, old and unversioned URLs", async () => {
    const { add, get } = await endpoint();
    const c = add(clip("a"));
    const version = mediaVersion(c.fileModifiedAt, c.fileSizeBytes);
    const response = await get(c, `?v=${version}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(JPEG)).toBe(true);

    expect((await get(c, "?v=old")).headers.get("cache-control")).toBe("no-store");
    expect((await get(c)).headers.get("cache-control")).toBe("no-store");
  });

  it("answers If-None-Match with 304 without rendering", async () => {
    const { add, get, runner } = await endpoint();
    const c = add(clip("b"));
    const response = await get(c, "", { "If-None-Match": `"${thumbnailCacheKey(c)}"` });
    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runner.jobs).toHaveLength(0);
  });

  it("keeps lookup failures and invalid stored cache keys no-store", async () => {
    const lookupError = await handleThumbnailRequest(new Request("http://localhost/thumbnail"), randomUUID(), {
      findClip: async () => { throw new Error("synthetic database unavailable"); },
      getThumbnail: async () => { throw new Error("must not render"); },
      logger: silentMediaLogger,
    });
    expect(lookupError.status).toBe(503);
    expect(lookupError.headers.get("cache-control")).toBe("no-store");
    const { add, get, runner } = await endpoint();
    const badKey = await get(add(clip("a", { id: "invalid-stored-uuid" })));
    expect(badKey.status).toBe(422);
    expect(runner.jobs).toHaveLength(0);
  });

  it("uses 404 / 422 / 503 consistently and never leaks paths", async () => {
    const unknown = await (await endpoint()).get({ id: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const invalid = await (await endpoint()).get({ id: "not-a-uuid" });
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("cache-control")).toBe("no-store");

    const missingFile = await endpoint();
    const gone = await missingFile.get(missingFile.add(clip("gone")));
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect(await gone.json()).toEqual({ error: "video-unavailable", message: "Videodatei nicht verfügbar" });

    const broken = await endpoint(() => "partial-fail");
    const failed = await broken.get(broken.add(clip("c")));
    expect(failed.status).toBe(422);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    const text = await failed.text();
    expect(text).not.toContain(base);
    expect(text).not.toContain("moov");

    const slow = await endpoint(() => "timeout");
    expect((await slow.get(slow.add(clip("d")))).status).toBe(503);
  });
});

describe("real runner (no ffmpeg needed)", () => {
  // Node itself stands in for the binary: the runner only spawns a program with arguments.
  const node = createFfmpegRunner(process.execPath);

  it("reports a missing binary as unavailable", async () => {
    const error = await createFfmpegRunner(path.join(base, "no-ffmpeg"))
      .run({ args: ["-version"], timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).kind).toBe("unavailable");
  });

  it("kills the process after the timeout", async () => {
    const started = Date.now();
    const error = await node.run({ args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 300 }).catch((e: unknown) => e);
    expect((error as FfmpegError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a non-zero exit with the end of stderr", async () => {
    const error = await node
      .run({ args: ["-e", "console.error('moov atom not found'); process.exit(1)"], timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect((error as FfmpegError).kind).toBe("failed");
    expect((error as Error).message).toContain("moov atom not found");
  });

  it("passes arguments without a shell and the input as descriptor 3", async () => {
    const out = path.join(base, "runner-out.txt");
    const { open } = await import("node:fs/promises");
    const handle = await open(path.join(archiveRoot, "2026-03-29", "a.mp4"), "r");
    try {
      await node.run({
        args: [
          "-e",
          "require('fs').writeFileSync(process.argv[2], process.argv[1] + '|' + require('fs').readFileSync('/dev/fd/3', 'utf8'))",
          "$(touch /tmp/pwned); `id`",
          out,
        ],
        inputFd: handle.fd,
        timeoutMs: 10_000,
      });
    } finally {
      await handle.close();
    }
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(out, "utf8")).toBe(`$(touch /tmp/pwned); \`id\`|${SOURCE} a`);
  });
});

describe("media config and limiter", () => {
  it("reads defaults and validates values", () => {
    expect(readMediaConfig({}, "/srv/app")).toEqual({
      ffmpegPath: "ffmpeg",
      thumbnailCacheRoot: "/srv/app/.cache/thumbnails",
      thumbnailMaxConcurrency: 2,
    });
    expect(readMediaConfig({ FFMPEG_PATH: "/usr/bin/ffmpeg", THUMBNAIL_CACHE_ROOT: "/data/thumbnails", THUMBNAIL_MAX_CONCURRENCY: "4" }, "/")).toEqual({
      ffmpegPath: "/usr/bin/ffmpeg",
      thumbnailCacheRoot: "/data/thumbnails",
      thumbnailMaxConcurrency: 4,
    });
    for (const bad of ["0", "17", "1.5", "two"]) {
      expect(() => readMediaConfig({ THUMBNAIL_MAX_CONCURRENCY: bad })).toThrow(/THUMBNAIL_MAX_CONCURRENCY/);
    }
  });

  it("runs jobs in FIFO order within the limit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(limiter.running).toBe(0);
    await expect(limiter.run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(limiter.running).toBe(0);
    expect(() => new ConcurrencyLimiter(0)).toThrow(RangeError);
  });
});
