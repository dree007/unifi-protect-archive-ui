import { describe, expect, it } from "vitest";

import { isPgError } from "@/server/db/errors";
import {
  createArchivedClip,
  findArchivedClipByPath,
  listArchivedClips,
  markArchivedClipSeenByPath,
  upsertArchivedClip,
  upsertArchivedClips,
} from "@/server/repositories/archived-clips";
import { upsertCamera } from "@/server/repositories/cameras";

import { clipInput, connectTestDb, expectDbError, PgErrorCode, uniqueProtectId } from "./helpers";

const { db } = connectTestDb();

describe("archived clips", () => {
  it("stores a clip without a known camera and finds it by path", async () => {
    const input = clipInput();
    const clip = await createArchivedClip(input, db);

    expect(clip).toMatchObject({
      cameraId: null,
      cameraName: "Driveway",
      filePath: input.filePath,
      fileName: input.fileName,
      durationMs: 73_000,
      fileSizeBytes: 91_900_000,
      dayDirectory: "2026-03-29",
    });
    // Same instant regardless of the offset it was written with.
    expect(clip.startAt.toISOString()).toBe("2026-03-29T11:01:05.000Z");
    expect(clip.discoveredAt).toEqual(clip.lastSeenAt);
    expect(await findArchivedClipByPath(input.filePath, db)).toEqual(clip);
    expect(await findArchivedClipByPath("2026-03-29/does-not-exist.mp4", db)).toBeUndefined();
  });

  it("rejects a second clip with the same file path", async () => {
    const input = clipInput();
    await createArchivedClip(input, db);

    const error = await createArchivedClip({ ...input, cameraName: "Doorbell" }, db).catch((e: unknown) => e);
    expect(isPgError(error, PgErrorCode.uniqueViolation, "archived_clips_file_path_unique")).toBe(true);
  });

  it("refreshes a known file on re-scan, keeping identity, discovery time and camera", async () => {
    const camera = await upsertCamera({ protectDeviceId: uniqueProtectId(), name: "Driveway", state: "online" }, db);
    const firstSeen = new Date("2026-03-29T12:00:00Z");
    const input = clipInput({ cameraId: camera.id, seenAt: firstSeen });
    const first = await upsertArchivedClip(input, db);

    const rescanned = await upsertArchivedClip(
      { ...input, cameraId: null, fileSizeBytes: 92_000_000, seenAt: new Date("2026-03-30T12:00:00Z") },
      db,
    );

    expect(rescanned.id).toBe(first.id);
    expect(rescanned.cameraId).toBe(camera.id);
    expect(rescanned.fileSizeBytes).toBe(92_000_000);
    expect(rescanned.discoveredAt).toEqual(firstSeen);
    expect(rescanned.lastSeenAt).toEqual(new Date("2026-03-30T12:00:00Z"));
  });

  it("lists clips newest first, filtered by camera and start time", async () => {
    const camera = await upsertCamera({ protectDeviceId: uniqueProtectId(), name: "Garden", state: "online" }, db);
    const at = (iso: string) => clipInput({ cameraId: camera.id, cameraName: "Garden", startAt: new Date(iso) });
    const early = await createArchivedClip(at("2026-10-05T07:00:00+02:00"), db);
    const late = await createArchivedClip(at("2026-10-06T07:42:13+02:00"), db);
    await createArchivedClip(clipInput({ startAt: new Date("2026-10-06T08:00:00+02:00") }), db);

    const all = await listArchivedClips({ cameraId: camera.id }, db);
    expect(all.map((clip) => clip.id)).toEqual([late.id, early.id]);

    const day = await listArchivedClips(
      { cameraId: camera.id, from: new Date("2026-10-06T00:00:00+02:00"), to: new Date("2026-10-07T00:00:00+02:00") },
      db,
    );
    expect(day.map((clip) => clip.id)).toEqual([late.id]);
  });

  it("classifies batch upserts as inserted, updated or unchanged", async () => {
    const a = clipInput({ seenAt: new Date("2026-03-29T12:00:00Z") });
    const b = clipInput({ seenAt: new Date("2026-03-29T12:00:00Z") });
    const first = await upsertArchivedClips([a, b], db);
    expect(first.map((r) => r.outcome)).toEqual(["inserted", "inserted"]);

    const later = new Date("2026-03-30T12:00:00Z");
    const c = clipInput({ seenAt: later });
    const second = await upsertArchivedClips(
      [{ ...a, seenAt: later }, { ...b, fileSizeBytes: 1, seenAt: later }, c],
      db,
    );
    const byPath = Object.fromEntries(second.map((r) => [r.clip.filePath, r]));
    expect(byPath[a.filePath].outcome).toBe("unchanged");
    expect(byPath[b.filePath].outcome).toBe("updated");
    expect(byPath[c.filePath].outcome).toBe("inserted");

    // updatedAt only moves on real changes; lastSeenAt always.
    const unchanged = byPath[a.filePath].clip;
    const original = first.find((r) => r.clip.filePath === a.filePath)!.clip;
    expect(unchanged.updatedAt).toEqual(original.updatedAt);
    expect(unchanged.lastSeenAt).toEqual(later);
    expect(unchanged.discoveredAt).toEqual(new Date("2026-03-29T12:00:00Z"));
  });

  it("marks a known clip as seen without touching metadata or creating unknown clips", async () => {
    const input = clipInput({ seenAt: new Date("2026-03-29T12:00:00Z") });
    const clip = await createArchivedClip(input, db);

    const later = new Date("2026-03-30T12:00:00Z");
    expect(await markArchivedClipSeenByPath(input.filePath, later, db)).toBe(true);
    const seen = await findArchivedClipByPath(input.filePath, db);
    expect(seen).toEqual({ ...clip, lastSeenAt: later });

    // Never moves backwards.
    await markArchivedClipSeenByPath(input.filePath, new Date("2026-03-29T00:00:00Z"), db);
    expect((await findArchivedClipByPath(input.filePath, db))?.lastSeenAt).toEqual(later);

    const unknown = `2026-03-29/unknown ${crypto.randomUUID()}.mp4`;
    expect(await markArchivedClipSeenByPath(unknown, later, db)).toBe(false);
    expect(await findArchivedClipByPath(unknown, db)).toBeUndefined();
  });

  it("only accepts paths relative to the archive root", async () => {
    for (const filePath of ["/archive/2026-03-29/x.mp4", "../outside.mp4", "2026-03-29/../../x.mp4"]) {
      await expectDbError(
        createArchivedClip(clipInput({ filePath }), db),
        PgErrorCode.checkViolation,
        "archived_clips_file_path_relative",
      );
    }
    // Two dots inside a name are fine.
    await createArchivedClip(clipInput({ filePath: `2026-03-29/Cam..2 ${crypto.randomUUID()}.mp4` }), db);
  });

  it("rejects clips that end before they start", async () => {
    const startAt = new Date("2026-10-06T07:42:13Z");
    await expectDbError(
      createArchivedClip(clipInput({ startAt, endAt: new Date(startAt.getTime() - 1000), durationMs: 1000 }), db),
      PgErrorCode.checkViolation,
      "archived_clips_end_not_before_start",
    );
  });
});
