import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaLogger } from "@/server/media/media-logger";
import { handleVideoRequest, type VideoRequestDeps } from "@/server/media/video-response";
import type { ClipMediaRow } from "@/server/queries/clips";

const SIZE = 64 * 1024 + 7;
const MTIME = new Date("2026-03-29T11:02:18.000Z");
/** Deterministic content: byte i = i mod 251, so any slice can be checked. */
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

let base: string;
let root: string;
const clips = new Map<string, ClipMediaRow>();
const logged: string[] = [];
const logger: MediaLogger = { warn: (m) => logged.push(`warn ${m}`), error: (m) => logged.push(`error ${m}`) };

function addClip(filePath: string): string {
  const id = randomUUID();
  clips.set(id, { id, filePath, fileSizeBytes: SIZE, fileModifiedAt: MTIME, durationMs: 73_000 });
  return id;
}

let ok: string;
let empty: string;
let missing: string;
let traversal: string;
let symlinked: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "unifi-archive-video-"));
  root = path.join(base, "archive");
  await mkdir(path.join(root, "2026-03-29"), { recursive: true });
  const file = path.join(root, "2026-03-29", "Driveway 1.01.05pm.mp4");
  await writeFile(file, CONTENT);
  await utimes(file, MTIME, MTIME);
  await writeFile(path.join(root, "2026-03-29", "empty.mp4"), "");
  await writeFile(path.join(base, "secret.mp4"), "secret");
  await symlink(path.join(base, "secret.mp4"), path.join(root, "2026-03-29", "link.mp4"));
  ok = addClip("2026-03-29/Driveway 1.01.05pm.mp4");
  empty = addClip("2026-03-29/empty.mp4");
  missing = addClip("2026-03-29/gone.mp4");
  // Cannot be stored by the database (CHECK constraint) – defence in depth.
  traversal = addClip("../secret.mp4");
  symlinked = addClip("2026-03-29/link.mp4");
});

afterAll(() => rm(base, { recursive: true, force: true }));

const deps = (): VideoRequestDeps => ({
  findClip: async (id) => clips.get(id),
  archiveRoot: root,
  logger,
});

async function request(clipId: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const response = await handleVideoRequest(
    new Request(`http://localhost/api/clips/${clipId}/video`, { method: init.method ?? "GET", headers: init.headers }),
    clipId,
    deps(),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}

async function body(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("video endpoint", () => {
  it("serves the whole file with 200 and the expected headers", async () => {
    const response = await request(ok);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("last-modified")).toBe(MTIME.toUTCString());
    expect(response.headers.get("etag")).toBe(`"${ok}-${SIZE.toString(16)}-${MTIME.getTime().toString(16)}"`);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    expect((await body(response)).equals(CONTENT)).toBe(true);
  });

  it("answers a range with 206", async () => {
    const response = await request(ok, { headers: { Range: "bytes=1000-1999" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${SIZE}`);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect((await body(response)).equals(CONTENT.subarray(1000, 2000))).toBe(true);
  });

  it("answers suffix and open-ended ranges", async () => {
    const suffix = await request(ok, { headers: { Range: "bytes=-500" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
    expect((await body(suffix)).equals(CONTENT.subarray(SIZE - 500))).toBe(true);

    const open = await request(ok, { headers: { Range: "bytes=65000-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-length")).toBe(String(SIZE - 65000));
    expect((await body(open)).equals(CONTENT.subarray(65000))).toBe(true);

    const last = await request(ok, { headers: { Range: `bytes=${SIZE - 1}-${SIZE - 1}` } });
    expect((await body(last)).equals(CONTENT.subarray(SIZE - 1))).toBe(true);
  });

  it("answers unsatisfiable, broken and multiple ranges with 416", async () => {
    for (const range of [`bytes=${SIZE}-`, "bytes=500-100", "bytes=abc", "bytes=0-1,4-5"]) {
      const response = await request(ok, { headers: { Range: range } });
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
      expect(response.headers.get("content-type")).not.toContain("multipart");
    }
  });

  it("answers HEAD with the same headers and no body", async () => {
    const head = await request(ok, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(SIZE));
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("etag")).toBeTruthy();
    expect(head.headers.get("last-modified")).toBe(MTIME.toUTCString());
    expect(head.body).toBeNull();

    const ranged = await request(ok, { method: "HEAD", headers: { Range: "bytes=0-9" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-length")).toBe("10");
    expect(ranged.body).toBeNull();
  });

  it("keeps HEAD errors no-store without bodies or unnecessary media metadata", async () => {
    for (const id of ["not-a-uuid", randomUUID(), missing]) {
      const response = await request(id, { method: "HEAD" });
      expect(response.status).toBe(404);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBeNull();
    }
    const invalidRange = await request(ok, { method: "HEAD", headers: { Range: "bytes=abc" } });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("content-range")).toBe(`bytes */${SIZE}`);
    expect(invalidRange.body).toBeNull();
  });

  it("revalidates with ETags and ignores a stale If-Range", async () => {
    const etag = (await request(ok, { method: "HEAD" })).headers.get("etag")!;
    const notModified = await request(ok, { headers: { "If-None-Match": etag } });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBeNull();
    const headNotModified = await request(ok, { method: "HEAD", headers: { "If-None-Match": etag } });
    expect(headNotModified.status).toBe(304);
    expect(headNotModified.body).toBeNull();

    const matching = await request(ok, { headers: { Range: "bytes=0-9", "If-Range": etag } });
    expect(matching.status).toBe(206);
    const stale = await request(ok, { headers: { Range: "bytes=0-9", "If-Range": '"other"' } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-length")).toBe(String(SIZE));
    await stale.body?.cancel();
  });

  it("serves an empty file, but no range of it", async () => {
    const response = await request(empty);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect((await request(empty, { headers: { Range: "bytes=0-" } })).status).toBe(416);
  });

  it("answers unknown clips and missing files with 404, without paths", async () => {
    for (const id of [randomUUID(), "not-a-uuid", missing]) {
      const response = await request(id);
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain(root);
      expect(text).not.toContain(base);
      expect(text).not.toContain("2026-03-29");
    }
    const json = await (await request(missing)).json();
    expect(json).toEqual({ error: "video-unavailable", message: "Videodatei nicht verfügbar" });
  });

  it("rejects a traversal path from the database and symlinks, and logs them", async () => {
    logged.length = 0;
    for (const id of [traversal, symlinked]) {
      const response = await request(id);
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain(base);
      expect(text).not.toContain("secret");
    }
    expect(logged.filter((line) => line.includes("rejected archive path"))).toHaveLength(2);
  });

  it("answers 503 when the archive is not mounted or the database fails", async () => {
    for (const method of ["GET", "HEAD"]) {
      const unmounted = await handleVideoRequest(new Request(`http://localhost/x`, { method }), ok, { ...deps(), archiveRoot: path.join(base, "nope") });
      expect(unmounted.status).toBe(503);
      expect(unmounted.headers.get("cache-control")).toBe("no-store");
      expect(await unmounted.text()).not.toContain(base);

      const dbDown = await handleVideoRequest(new Request(`http://localhost/x`, { method }), ok, {
        ...deps(),
        findClip: () => Promise.reject(new Error("connect ECONNREFUSED")),
      });
      expect(dbDown.status).toBe(503);
      expect(dbDown.headers.get("cache-control")).toBe("no-store");
      expect(await dbDown.text()).not.toContain("ECONNREFUSED");
      if (method === "HEAD") {
        expect(unmounted.body).toBeNull();
        expect(dbDown.body).toBeNull();
      }
    }
  });

  it("does not log successful (range) requests or cancelled downloads", async () => {
    logged.length = 0;
    await body(await request(ok, { headers: { Range: "bytes=0-99" } }));
    await body(await request(ok));
    const reader = (await request(ok)).body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logged).toEqual([]);
  });

  it.runIf(process.platform === "linux")("closes the file descriptor on every path (no leaks)", async () => {
    const openFds = async () => (await readdir("/proc/self/fd")).length;
    const etag = (await request(ok, { method: "HEAD" })).headers.get("etag")!;
    const before = await openFds();
    for (let i = 0; i < 20; i++) {
      await request(ok, { method: "HEAD" });
      await request(ok, { headers: { Range: "bytes=999999-" } });
      await request(ok, { headers: { "If-None-Match": etag } });
      await body(await request(ok, { headers: { Range: "bytes=0-99" } }));
      // A client that aborts the download, and one that disconnects before reading anything.
      await (await request(ok)).body?.cancel();
      const controller = new AbortController();
      await handleVideoRequest(
        new Request(`http://localhost/api/clips/${ok}/video`, { signal: controller.signal }),
        ok,
        deps(),
      );
      controller.abort();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await openFds()).toBeLessThanOrEqual(before);
  });
});
