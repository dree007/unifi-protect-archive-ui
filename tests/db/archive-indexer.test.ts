import { chmod } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  runArchiveScan,
  runDryArchiveScan,
  ScanAlreadyRunningError,
  type ScanOptions,
} from "@/server/archive/archive-indexer";
import { classifyStatError, discoverArchive } from "@/server/archive/filesystem-scanner";
import { archivedClips, archiveScanRuns } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { findArchivedClipByPath } from "@/server/repositories/archived-clips";
import { findScanRunById, listMissingClips, startScanRun } from "@/server/repositories/archive-scan-runs";

import { CLIP, createTempArchive } from "../support/archive-fixture";
import { createIsolatedDb } from "./helpers";

const DAY = "2026-03-29";

/** Every test gets its own database (missing counts span the whole table) and archive. */
async function setup(files: string[] = [CLIP.driveway, CLIP.garden, CLIP.doorbell]) {
  const { db, pool } = await createIsolatedDb();
  const archive = await createTempArchive();
  for (const name of files) await archive.addFile(`${DAY}/${name}`, { size: 1000 });
  const scan = (options: Partial<ScanOptions> = {}) =>
    runArchiveScan({ archiveRoot: archive.root, db, batchSize: 2, ...options });
  return { db, pool, archive, scan };
}

/**
 * Discovery as the scanner would report it if `lstat` of `relativePath` failed with `code`
 * after the file was listed (EACCES, ENOENT, …); classification via the real scanner logic.
 */
function withStatError(relativePath: string, code: string): NonNullable<ScanOptions["discover"]> {
  return async function* (root, options) {
    for await (const item of discoverArchive(root, options)) {
      if (item.kind === "file" && item.file.relativePath === relativePath) {
        yield {
          kind: "fileError",
          relativePath,
          code,
          message: `cannot read file metadata (${code})`,
          presence: classifyStatError(code),
        };
      } else {
        yield item;
      }
    }
  };
}

const isRoot = process.getuid?.() === 0;

const allClips = (db: Database) => db.select().from(archivedClips).orderBy(archivedClips.filePath);

describe("archive indexer", () => {
  it("indexes all clips on the initial scan and records a completed run", async () => {
    const { db, archive, scan } = await setup();

    const result = await scan();

    expect(result.status).toBe("completed");
    expect(result.archiveRoot).toBe(archive.root);
    expect(result.counts).toEqual({
      dayDirectoryCount: 1,
      discoveredCount: 3,
      updatedCount: 0,
      unchangedCount: 0,
      failedCount: 0,
      warningCount: 0,
    });
    expect(result.missingCount).toBe(0);

    const clips = await allClips(db);
    expect(clips).toHaveLength(3);
    const driveway = clips.find((clip) => clip.cameraName === "Driveway")!;
    expect(driveway).toMatchObject({
      cameraId: null,
      filePath: `${DAY}/${CLIP.driveway}`,
      fileName: CLIP.driveway,
      dayDirectory: DAY,
      durationMs: 73_000,
      fileSizeBytes: 1000,
    });
    expect(driveway.startAt.toISOString()).toBe("2026-03-29T11:01:05.000Z");
    expect(driveway.discoveredAt).toEqual(result.startedAt);
    expect(driveway.lastSeenAt).toEqual(result.startedAt);

    const run = await findScanRunById(result.runId!, db);
    expect(run).toMatchObject({
      status: "completed",
      archiveRoot: archive.root,
      dayDirectoryCount: 1,
      discoveredCount: 3,
      failedCount: 0,
      warningCount: 0,
      missingCount: 0,
      errorMessage: null,
    });
    expect(run!.finishedAt!.getTime()).toBeGreaterThanOrEqual(run!.startedAt.getTime());
  });

  it("is idempotent: a second scan creates no duplicates and only refreshes lastSeenAt", async () => {
    const { db, scan } = await setup();
    const first = await scan();
    const before = await allClips(db);

    const second = await scan();

    expect(second.counts).toMatchObject({ discoveredCount: 0, updatedCount: 0, unchangedCount: 3 });
    const after = await allClips(db);
    expect(after).toHaveLength(3);
    for (const [index, clip] of after.entries()) {
      expect(clip.id).toBe(before[index].id);
      expect(clip.discoveredAt).toEqual(first.startedAt);
      expect(clip.lastSeenAt).toEqual(second.startedAt);
      expect(clip.updatedAt).toEqual(before[index].updatedAt);
    }
    expect(second.startedAt.getTime()).toBeGreaterThan(first.startedAt.getTime());
  });

  it("updates size and modification time of a changed file", async () => {
    const { db, archive, scan } = await setup();
    await scan();

    const mtime = new Date("2026-03-30T08:00:00.000Z");
    await archive.addFile(`${DAY}/${CLIP.garden}`, { size: 2500, mtime });
    const result = await scan();

    expect(result.counts).toMatchObject({ discoveredCount: 0, updatedCount: 1, unchangedCount: 2 });
    const garden = await findArchivedClipByPath(`${DAY}/${CLIP.garden}`, db);
    expect(garden).toMatchObject({ fileSizeBytes: 2500, fileModifiedAt: mtime });
  });

  it("adds only the new file", async () => {
    const { db, archive, scan } = await setup();
    await scan();

    await archive.addFile(`2026-03-30/${CLIP.nextDay}`);
    const result = await scan();

    expect(result.counts).toMatchObject({ dayDirectoryCount: 2, discoveredCount: 1, unchangedCount: 3 });
    expect(await allClips(db)).toHaveLength(4);
  });

  it("detects files missing from a completed scan without deleting them", async () => {
    const { db, pool, archive, scan } = await setup();
    await scan();

    await archive.remove(`${DAY}/${CLIP.doorbell}`);
    const result = await scan();

    expect(result.missingCount).toBe(1);
    expect(await allClips(db)).toHaveLength(3);
    const missing = await listMissingClips({}, db);
    expect(missing.basis?.id).toBe(result.runId);
    expect(missing.clips.map((clip) => clip.filePath)).toEqual([`${DAY}/${CLIP.doorbell}`]);

    // The same result in plain SQL (later used by reports): clips seen by the run must not
    // compare as older than its start, e.g. because of sub-millisecond precision.
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from archived_clips
       where last_seen_at < (select started_at from archive_scan_runs where id = $1)`,
      [result.runId],
    );
    expect(rows[0].n).toBe(1);

    // Back on the NAS: no longer missing.
    await archive.addFile(`${DAY}/${CLIP.doorbell}`, { size: 1000 });
    const again = await scan();
    expect(again.missingCount).toBe(0);
    expect((await listMissingClips({}, db)).clips).toEqual([]);
  });

  it("never uses a failed scan for missing detection", async () => {
    const { db, scan } = await setup();
    const completed = await scan();

    // The NAS connection drops after the first file of the next scan.
    const failed = await scan({
      discover: async function* (root, options) {
        for await (const item of discoverArchive(root, options)) {
          yield item;
          if (item.kind === "file") throw Object.assign(new Error("Host is down"), { code: "EHOSTDOWN" });
        }
      },
    });

    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("EHOSTDOWN: Host is down");
    expect(failed.missingCount).toBeNull();
    const run = await findScanRunById(failed.runId!, db);
    expect(run).toMatchObject({ status: "failed", missingCount: null, errorMessage: "EHOSTDOWN: Host is down" });
    expect(run!.finishedAt).not.toBeNull();

    // Two thirds of the archive were not reached, but nothing counts as missing.
    const missing = await listMissingClips({}, db);
    expect(missing.basis?.id).toBe(completed.runId);
    expect(missing.clips).toEqual([]);
  });

  it("reports no missing clips before the first completed scan", async () => {
    const { db } = await setup();
    await runArchiveScan({ archiveRoot: "/definitely/not/there", db });
    expect(await listMissingClips({}, db)).toEqual({ basis: undefined, clips: [] });
  });

  it("indexes the other files when one file name cannot be parsed", async () => {
    const { db, archive, scan } = await setup([CLIP.driveway, CLIP.garden]);
    await archive.addFile(`${DAY}/defekt.mp4`);

    const result = await scan();

    expect(result.status).toBe("completed");
    expect(result.filesFound).toBe(3);
    expect(result.counts).toMatchObject({ discoveredCount: 2, failedCount: 1 });
    expect(result.failures).toEqual([
      { relativePath: `${DAY}/defekt.mp4`, message: expect.stringContaining("unrecognizedFormat") },
    ]);
    expect(await allClips(db)).toHaveLength(2);
    expect((await findScanRunById(result.runId!, db))?.failedCount).toBe(1);
  });

  it("indexes a clip in the wrong day folder with a warning", async () => {
    const { db, archive, scan } = await setup([CLIP.driveway]);
    await archive.addFile(`${DAY}/${CLIP.nextDay}`); // starts on 2026-03-30

    const result = await scan();

    expect(result.counts).toMatchObject({ discoveredCount: 2, warningCount: 1 });
    expect(result.warnings).toEqual([
      {
        relativePath: `${DAY}/${CLIP.nextDay}`,
        message: "day folder 2026-03-29 does not match start date 2026-03-30 from the file name",
      },
    ]);
    expect(await findArchivedClipByPath(`${DAY}/${CLIP.nextDay}`, db)).toMatchObject({ dayDirectory: DAY });
    expect((await findScanRunById(result.runId!, db))?.warningCount).toBe(1);
  });

  it("compares the start date with the date of a UniFi-Protect_ day folder", async () => {
    const { db, archive, scan } = await setup([]);
    const folder = `UniFi-Protect_${DAY}`;
    await archive.addFile(`${folder}/${CLIP.driveway}`);
    await archive.addFile(`${folder}/${CLIP.nextDay}`); // starts on 2026-03-30

    const result = await scan();

    expect(result.counts).toMatchObject({ dayDirectoryCount: 1, discoveredCount: 2, warningCount: 1 });
    expect(result.warnings).toEqual([
      {
        relativePath: `${folder}/${CLIP.nextDay}`,
        message: `day folder ${folder} does not match start date 2026-03-30 from the file name`,
      },
    ]);
    expect(await findArchivedClipByPath(`${folder}/${CLIP.driveway}`, db)).toMatchObject({ dayDirectory: folder });
  });

  it("keeps the run in `running` while scanning", async () => {
    const { db, scan } = await setup();
    const statuses: string[] = [];
    await scan({
      discover: async function* (root, options) {
        const runs = await db.select().from(archiveScanRuns);
        statuses.push(...runs.map((run) => run.status));
        yield* discoverArchive(root, options);
      },
    });
    expect(statuses).toEqual(["running"]);
  });

  it.each([
    ["/definitely/not/there", /does not exist/],
    [undefined, /ARCHIVE_ROOT is not set/],
    ["relative/path", /must be an absolute path/],
  ])("ends the run as failed for archive root %j", async (archiveRoot, message) => {
    const { db } = await setup();
    const result = await runArchiveScan({ archiveRoot, db });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(message);
    const run = await findScanRunById(result.runId!, db);
    expect(run?.status).toBe("failed");
    expect(run?.errorMessage).toMatch(message);
  });

  it("allows only one scan at a time and cleans up interrupted runs", async () => {
    const { db, scan } = await setup();
    // A run left behind by a crashed process.
    const stale = await startScanRun("/archive", db);

    let nested: unknown;
    await scan({
      discover: async function* (root, options) {
        nested = await scan().catch((error: unknown) => error);
        yield* discoverArchive(root, options);
      },
    });

    expect(nested).toBeInstanceOf(ScanAlreadyRunningError);
    const staleAfter = await findScanRunById(stale.id, db);
    expect(staleAfter).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/Interrupted/) });
    const runs = await db.select().from(archiveScanRuns).where(eq(archiveScanRuns.status, "completed"));
    expect(runs).toHaveLength(1);
  });

  it("writes nothing in a dry run", async () => {
    const { db, archive } = await setup([CLIP.driveway, CLIP.garden]);
    await archive.addFile(`${DAY}/defekt.mp4`);

    const result = await runDryArchiveScan({ archiveRoot: archive.root });

    expect(result).toMatchObject({ status: "dryRun", filesFound: 3, missingCount: null });
    expect(result.counts).toMatchObject({ dayDirectoryCount: 1, failedCount: 1, discoveredCount: 0 });
    expect(await allClips(db)).toEqual([]);
    expect(await db.select().from(archiveScanRuns)).toEqual([]);
  });

  describe("metadata errors of single files (no false missing)", () => {
    it.each(["EACCES", "EPERM"])(
      "keeps a known clip present and unchanged when its metadata fails with %s",
      async (code) => {
        const { db, scan } = await setup();
        await scan();
        const path = `${DAY}/${CLIP.doorbell}`;
        const before = await findArchivedClipByPath(path, db);

        const result = await scan({ discover: withStatError(path, code) });

        expect(result.status).toBe("completed");
        expect(result.filesFound).toBe(3);
        expect(result.counts).toMatchObject({ failedCount: 1, unchangedCount: 2, discoveredCount: 0 });
        expect(result.failures).toEqual([
          { relativePath: path, message: `cannot read file metadata (${code}); known clip kept as present` },
        ]);
        expect(result.missingCount).toBe(0);
        expect((await listMissingClips({}, db)).clips).toEqual([]);

        // Seen in this scan; size, mtime, times and updatedAt untouched.
        const after = await findArchivedClipByPath(path, db);
        expect(after).toEqual({ ...before, lastSeenAt: result.startedAt });
        expect((await findScanRunById(result.runId!, db))?.failedCount).toBe(1);
      },
    );

    it("does not index an unknown file whose metadata cannot be read", async () => {
      const { db, archive, scan } = await setup([CLIP.driveway, CLIP.garden]);
      await scan();
      await archive.addFile(`${DAY}/${CLIP.doorbell}`);
      const path = `${DAY}/${CLIP.doorbell}`;

      const result = await scan({ discover: withStatError(path, "EACCES") });

      expect(result.status).toBe("completed");
      expect(result.counts).toMatchObject({ failedCount: 1, discoveredCount: 0, unchangedCount: 2 });
      expect(result.failures).toEqual([
        { relativePath: path, message: "cannot read file metadata (EACCES); not indexed" },
      ]);
      expect(await findArchivedClipByPath(path, db)).toBeUndefined();
      expect(await allClips(db)).toHaveLength(2);
    });

    it("lets a known clip that vanished during the scan (ENOENT) become missing", async () => {
      const { db, scan } = await setup();
      const first = await scan();
      const path = `${DAY}/${CLIP.doorbell}`;

      const result = await scan({ discover: withStatError(path, "ENOENT") });

      expect(result.status).toBe("completed");
      // Not a failure of the archive: the file is simply gone.
      expect(result.counts).toMatchObject({ failedCount: 0, unchangedCount: 2 });
      expect(result.filesFound).toBe(2);
      expect(result.missingCount).toBe(1);
      expect((await listMissingClips({}, db)).clips.map((clip) => clip.filePath)).toEqual([path]);
      // Not marked as seen; the row itself is kept.
      expect((await findArchivedClipByPath(path, db))?.lastSeenAt).toEqual(first.startedAt);
    });

    it("counts an unreadable file in a dry run without touching the database", async () => {
      const { db, archive } = await setup([CLIP.driveway, CLIP.garden]);
      const result = await runDryArchiveScan({
        archiveRoot: archive.root,
        discover: withStatError(`${DAY}/${CLIP.garden}`, "EACCES"),
      });
      expect(result.counts.failedCount).toBe(1);
      expect(await allClips(db)).toEqual([]);
    });

    it.skipIf(isRoot)("fails the whole scan when a day directory is unreadable (real EACCES)", async () => {
      const { db, archive, scan } = await setup();
      const completed = await scan();
      await chmod(archive.path(DAY), 0o000);
      try {
        const result = await scan();
        expect(result.status).toBe("failed");
        expect(result.errorMessage).toMatch(/EACCES/);
      } finally {
        await chmod(archive.path(DAY), 0o755);
      }
      const missing = await listMissingClips({}, db);
      expect(missing.basis?.id).toBe(completed.runId);
      expect(missing.clips).toEqual([]);
    });

    it.skipIf(isRoot)("keeps a known clip present with a real EACCES on lstat", async () => {
      const { db, archive, scan } = await setup();
      await scan();
      // Listable but not searchable: lstat of every file fails with EACCES.
      await chmod(archive.path(DAY), 0o444);
      let result;
      try {
        result = await scan();
      } finally {
        await chmod(archive.path(DAY), 0o755);
      }
      expect(result.status).toBe("completed");
      expect(result.counts).toMatchObject({ failedCount: 3, unchangedCount: 0 });
      expect(result.missingCount).toBe(0);
      expect(await allClips(db)).toHaveLength(3);
    });
  });
});
