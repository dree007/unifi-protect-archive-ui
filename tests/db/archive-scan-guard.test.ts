import { describe, expect, it } from "vitest";

import { runArchiveScan, type ScanOptions } from "@/server/archive/archive-indexer";
import { listMissingClips } from "@/server/repositories/archive-scan-runs";

import { clipPath, createTempArchive } from "../support/archive-fixture";
import { createIsolatedDb } from "./helpers";

/** An archive with `count` clips, one per minute, and its first completed scan. */
async function scannedArchive(count: number) {
  const { db } = await createIsolatedDb();
  const archive = await createTempArchive();
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const relative = clipPath(i % 2 ? "Garden" : "Driveway", new Date(Date.UTC(2026, 7, 10, 8, i)), 20);
    paths.push(relative);
    await archive.addFile(relative, { size: 100 });
  }
  const scan = (options: Partial<ScanOptions> = {}) => runArchiveScan({ archiveRoot: archive.root, db, ...options });
  const first = await scan();
  expect(first).toMatchObject({ status: "completed", filesFound: count, missingCount: 0 });
  return { db, archive, paths, scan };
}

describe("archive scan: protection against a vanished NAS mount", () => {
  it("an empty directory where the archive was: run fails, no clip becomes missing", async () => {
    const { db, archive, paths, scan } = await scannedArchive(60);
    // The mount is gone; the mount point is still there, empty.
    for (const relative of new Set(paths.map((p) => p.split("/")[0]))) await archive.remove(relative);

    const result = await scan();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("no MP4 files found, but 60 clips were present before");
    expect(result.missingCount).toBeNull();
    // Missing detection still uses the last completed run: nothing is missing.
    const missing = await listMissingClips({}, db);
    expect(missing.clips).toHaveLength(0);
  });

  it("an archive root that does not exist at all fails the run", async () => {
    const { db, archive, scan } = await scannedArchive(3);
    const result = await scan({ archiveRoot: `${archive.root}/gone` });
    expect(result).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("does not exist") });
    expect((await listMissingClips({}, db)).clips).toHaveLength(0);
  });

  it("a sudden drop by more than half is refused; --accept-missing completes it", async () => {
    const { db, archive, paths, scan } = await scannedArchive(120);
    for (const relative of paths.slice(0, 80)) await archive.remove(relative);

    const refused = await scan();
    expect(refused.status).toBe("failed");
    expect(refused.errorMessage).toContain("80 of 120 clips (67 %) would be missing at once");
    expect((await listMissingClips({}, db)).clips).toHaveLength(0);

    // A later scan with the NAS still incomplete is refused again (same basis).
    expect((await scan()).status).toBe("failed");

    const accepted = await scan({ missingGuard: false });
    expect(accepted).toMatchObject({ status: "completed", missingCount: 80 });
    expect((await listMissingClips({ limit: 1000 }, db)).clips).toHaveLength(80);
  });

  it("normal deletions (retention) complete as before", async () => {
    const { db, archive, paths, scan } = await scannedArchive(120);
    for (const relative of paths.slice(0, 20)) await archive.remove(relative);
    expect(await scan()).toMatchObject({ status: "completed", missingCount: 20 });
    expect((await listMissingClips({ limit: 1000 }, db)).clips).toHaveLength(20);
  });

  it("ARCHIVE_REQUIRED_MOUNT that is not mounted fails the run before anything is read", async () => {
    const { archive, scan } = await scannedArchive(3);
    const result = await scan({ requiredMount: archive.root });
    expect(result).toMatchObject({ status: "failed", filesFound: 0 });
    expect(result.errorMessage).toBe("ARCHIVE_REQUIRED_MOUNT is not a mount point: the NAS is not mounted.");
    // A real mount point (the root file system) passes.
    expect(await scan({ requiredMount: "/" })).toMatchObject({ status: "completed" });
  });

  it("ARCHIVE_REQUIRED_FS_TYPE that does not match (empty bind mount in Docker) fails the run, nothing missing", async () => {
    const { db, archive, paths, scan } = await scannedArchive(60);
    // The NAS "disappears": the directory is empty and lies on the local file system.
    for (const relative of new Set(paths.map((p) => p.split("/")[0]))) await archive.remove(relative);
    const result = await scan({ requiredFsTypes: ["nfs4", "cifs"] });
    expect(result).toMatchObject({ status: "failed", filesFound: 0 });
    expect(result.errorMessage).toMatch(/^ARCHIVE_ROOT is on a "[^"]+" file system, expected nfs4 or cifs/);
    expect((await listMissingClips({}, db)).clips).toHaveLength(0);
  });

  it("an aborted scan (worker shutdown) is recorded as failed and changes nothing about missing", async () => {
    const { db, scan } = await scannedArchive(30);
    const controller = new AbortController();
    controller.abort();
    const result = await scan({ signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", errorMessage: "Interrupted: the scan was stopped (shutdown)." });
    expect((await listMissingClips({}, db)).clips).toHaveLength(0);
  });
});
