import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ARCHIVE_FILTERS } from "@/lib/archive-filters";
import { silentMediaLogger } from "@/server/media/media-logger";
import { handleVideoRequest } from "@/server/media/video-response";
import { getArchivePage, getEventDetail } from "@/server/queries/archive";
import { getClipMedia } from "@/server/queries/clips";
import { queryContext } from "@/server/queries/context";
import { createArchiveEventsWithMembers } from "@/server/repositories/archive-events";
import { createArchivedClip } from "@/server/repositories/archived-clips";

import { clipInput, createIsolatedDb } from "./helpers";

const { db } = await createIsolatedDb();
let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "unifi-archive-media-db-"));
  root = path.join(base, "archive");
  await mkdir(path.join(root, "2026-03-29"), { recursive: true });
});
afterAll(() => rm(base, { recursive: true, force: true }));

async function clipWithFile(cameraName: string, start: string, { withFile = true } = {}) {
  const input = clipInput({ cameraName, startAt: new Date(start) });
  let fileSizeBytes = input.fileSizeBytes;
  let fileModifiedAt: Date | null = null;
  if (withFile) {
    const target = path.join(root, input.filePath);
    await writeFile(target, Buffer.alloc(5000, 1));
    const stats = await stat(target);
    fileSizeBytes = stats.size;
    fileModifiedAt = stats.mtime;
  }
  return createArchivedClip({ ...input, fileSizeBytes, fileModifiedAt }, db);
}

const tableSnapshot = async () =>
  (
    await db.execute<{ snapshot: string }>(sql`
      select md5(string_agg(c::text, ',' order by c.id)) as snapshot from archived_clips c`)
  ).rows[0].snapshot;

describe("media endpoints against the database", () => {
  it("looks clips up by ID only", async () => {
    const clip = await clipWithFile("Driveway", "2026-03-29T11:01:05Z");
    expect(await getClipMedia(clip.id, db)).toEqual({
      id: clip.id,
      filePath: clip.filePath,
      fileSizeBytes: 5000,
      fileModifiedAt: clip.fileModifiedAt,
      durationMs: clip.durationMs,
    });
    expect(await getClipMedia(randomUUID(), db)).toBeUndefined();
    expect(await getClipMedia("2026-03-29/x.mp4", db)).toBeUndefined();
    expect(await getClipMedia("' or 1=1 --", db)).toBeUndefined();
  });

  it("streams a stored clip and never changes the database, even for missing files", async () => {
    const present = await clipWithFile("Doorbell", "2026-03-29T11:01:04Z");
    const missing = await clipWithFile("Garden", "2026-03-29T09:20:45Z", { withFile: false });
    const deps = { findClip: (id: string) => getClipMedia(id, db), archiveRoot: root, logger: silentMediaLogger };
    const before = await tableSnapshot();

    const ranged = await handleVideoRequest(
      new Request("http://localhost/x", { headers: { Range: "bytes=0-99" } }),
      present.id,
      deps,
    );
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const gone = await handleVideoRequest(new Request("http://localhost/x"), missing.id, deps);
    expect(gone.status).toBe(404);
    expect(await tableSnapshot()).toBe(before);
  });

  it("puts thumbnail and video URLs into cards and details", async () => {
    const doorbell = await clipWithFile("Doorbell", "2026-03-29T12:01:04Z");
    const driveway = await clipWithFile("Driveway", "2026-03-29T12:01:05Z");
    const [eventId] = await createArchiveEventsWithMembers([{ clipIds: [doorbell.id, driveway.id], protectEventIds: [] }], db);
    const context = queryContext({ db, now: new Date("2026-10-06T10:00:00Z"), timeZone: "Europe/Berlin" });

    const page = await getArchivePage(DEFAULT_ARCHIVE_FILTERS, null, context);
    const card = page.events.find((event) => event.id === eventId)!;
    expect(card.previews.map((preview) => preview.clipId)).toEqual([doorbell.id, driveway.id]);
    expect(card.previews[0].thumbnailUrl).toMatch(new RegExp(`^/api/clips/${doorbell.id}/thumbnail\\?v=[0-9a-z]+-[0-9a-z]+$`));

    const detail = (await getEventDetail(eventId, context))!;
    expect(detail.clips.map((clip) => [clip.label, clip.videoUrl])).toEqual([
      ["Doorbell", `/api/clips/${doorbell.id}/video`],
      ["Driveway", `/api/clips/${driveway.id}/video`],
    ]);
    expect(JSON.stringify(detail)).not.toContain(root);
  });
});
