import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDateFormat } from "@/lib/date-format";
import { assessMissing } from "@/server/archive/missing-guard";
import {
  assertFileSystemType,
  findContainingMount,
  isMountPoint,
  parseFileSystemTypes,
  parseMountInfo,
  parseMountPoints,
} from "@/server/archive/mount-check";
import { deriveBackgroundStatus, type StatusRow } from "@/server/view-models/background-status";
import { sanitizeStatusMessage } from "@/server/worker/sanitize";

const NOW = new Date("2026-10-09T12:00:00Z");
const format = createDateFormat("Europe/Berlin");
const STALE = 90_000;
const WORKER_ID = "0199c000-0000-7000-8000-000000000001";

function row(component: StatusRow["component"], state: string, overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    component,
    instanceId: WORKER_ID,
    state,
    heartbeatAt: null,
    heartbeatAgeMs: null,
    instanceStartedAt: null,
    lastStartedAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastErrorMessage: null,
    nextRunAt: null,
    details: null,
    updatedAt: new Date(NOW.getTime() - 5000),
    ...overrides,
  };
}

const worker = (state: string, ageMs: number | null = 12_000, overrides: Partial<StatusRow> = {}) =>
  row("worker", state, {
    heartbeatAgeMs: ageMs,
    heartbeatAt: ageMs === null ? null : new Date(NOW.getTime() - ageMs),
    instanceStartedAt: new Date(NOW.getTime() - 3_600_000),
    ...overrides,
  });

const derive = (rows: StatusRow[]) => deriveBackgroundStatus(rows, { staleMs: STALE, now: NOW, format, archiveRoot: "/srv/nas/unifi" });

describe("background status derivation", () => {
  it("fresh installation: never started, no component claims health", () => {
    const status = derive([]);
    expect(status.worker).toMatchObject({ kind: "notStarted", live: false });
    expect(status.protect.kind).toBe("noStatus");
    expect(status.scan.kind).toBe("noStatus");
    expect(status.reconciliation.kind).toBe("noStatus");
  });

  it.each([
    ["starting", 5_000, "starting", true],
    ["running", 12_000, "running", true],
    ["running", 90_000, "running", true],
    ["running", 90_001, "stale", false],
    ["running", 600_000, "stale", false],
    ["starting", 600_000, "stale", false],
    ["stopping", 10_000, "stopping", true],
    ["stopped", 600_000, "stopped", false],
    ["error", 600_000, "error", false],
  ])("worker %s with heartbeat age %d ms → %s", (state, age, kind, live) => {
    expect(derive([worker(state, age)]).worker).toMatchObject({ kind, live });
  });

  it("a stored `running` without a heartbeat is not proof of life", () => {
    expect(derive([worker("running", null)]).worker.kind).toBe("stale");
  });

  it("shows Protect states independently of a healthy worker", () => {
    for (const state of ["connecting", "connected", "reconnecting", "authenticationError", "error"]) {
      expect(derive([worker("running"), row("protect", state)]).protect.kind).toBe(state);
    }
    const reconnecting = derive([
      worker("running"),
      row("protect", "reconnecting", { lastErrorMessage: "Protect not available: connect ECONNREFUSED", lastFailedAt: NOW }),
      row("archiveScan", "success"),
      row("reconciliation", "success"),
    ]);
    expect(reconnecting.worker.kind).toBe("running");
    expect(reconnecting.protect).toMatchObject({ kind: "reconnecting", errorMessage: "Protect not available: connect ECONNREFUSED" });
    expect(reconnecting.scan.kind).toBe("success");
    expect(reconnecting.reconciliation.kind).toBe("success");
  });

  it("never shows Protect connected when the worker is stale or another instance wrote the row", () => {
    expect(derive([worker("running", 600_000), row("protect", "connected")]).protect.kind).toBe("unknown");
    expect(derive([worker("running"), row("protect", "connected", { instanceId: "0199c000-0000-7000-8000-000000000002" })]).protect.kind).toBe(
      "unknown",
    );
  });

  it("deliberately disabled Protect is shown as disabled, not as an error – even when the worker is stale", () => {
    expect(derive([worker("running"), row("protect", "disabled", { details: { disabledReason: "switchedOff" } })]).protect.kind).toBe("disabled");
    expect(derive([worker("stopped"), row("protect", "disabled", { details: { disabledReason: "notConfigured" } })]).protect.kind).toBe(
      "notConfigured",
    );
  });

  it("job states: running only while the worker is live, errors with sanitized messages", () => {
    expect(derive([worker("running"), row("archiveScan", "running")]).scan.kind).toBe("running");
    expect(derive([worker("running", 600_000), row("archiveScan", "running")]).scan.kind).toBe("unknown");
    const failed = derive([
      worker("running"),
      row("archiveScan", "error", { lastErrorMessage: "ARCHIVE_ROOT “/srv/nas/unifi” does not exist (is the NAS mounted?)." }),
      row("reconciliation", "error", { lastErrorMessage: "connect ECONNREFUSED postgresql://app:hunter2@db:5432/x" }),
    ]);
    expect(failed.scan).toMatchObject({ kind: "error", errorMessage: "ARCHIVE_ROOT does not exist (is the NAS mounted?)." });
    expect(failed.reconciliation.errorMessage).toBe("connect ECONNREFUSED postgresql://***@db:5432/x");
    expect(derive([worker("running"), row("archiveScan", "success", { lastErrorMessage: "old" })]).scan.errorMessage).toBeNull();
  });

  it("reconciliation summary and next runs", () => {
    const status = derive([
      worker("running"),
      row("reconciliation", "success", {
        lastSucceededAt: new Date(NOW.getTime() - 60_000),
        nextRunAt: new Date(NOW.getTime() + 240_000),
        details: { durationMs: 2500, archiveEventsCreated: 3, archiveEventsMerged: 1, archiveEventsSplit: 0, temporalFallbackEvents: 7 },
      }),
    ]);
    expect(status.reconciliation).toMatchObject({
      kind: "success",
      durationLabel: "3 Sek.",
      eventsCreated: 3,
      eventsMerged: 1,
      eventsSplit: 0,
      temporalFallbackEvents: 7,
      multiCameraEvents: null,
      nextRunLabel: "in 4 Minuten (14:04)",
    });
    // No next run from a worker that is not live.
    expect(derive([worker("stopped"), row("reconciliation", "success", { nextRunAt: NOW })]).reconciliation.nextRunLabel).toBeNull();
  });
});

describe("missing guard", () => {
  it("refuses an empty scan of a previously filled archive", () => {
    expect(assessMissing({ filesFound: 0, previouslyPresent: 12_000, newlyMissing: 12_000 })).toContain("no MP4 files found");
    expect(assessMissing({ filesFound: 0, previouslyPresent: 1, newlyMissing: 1 })).toContain("no MP4 files found");
  });

  it("refuses a sudden drop by more than half", () => {
    expect(assessMissing({ filesFound: 4000, previouslyPresent: 12_000, newlyMissing: 8000 })).toContain("8,000 of 12,000 clips (67 %)");
  });

  it("accepts normal changes, small archives and fresh installations", () => {
    expect(assessMissing({ filesFound: 11_900, previouslyPresent: 12_000, newlyMissing: 100 })).toBeNull();
    expect(assessMissing({ filesFound: 5, previouslyPresent: 40, newlyMissing: 35 })).toBeNull();
    expect(assessMissing({ filesFound: 0, previouslyPresent: 0, newlyMissing: 0 })).toBeNull();
    expect(assessMissing({ filesFound: 6000, previouslyPresent: 12_000, newlyMissing: 6000 })).toBeNull();
  });
});

describe("mount check", () => {
  it("parses /proc/self/mountinfo including escaped spaces", () => {
    const points = parseMountPoints(
      [
        "22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
        "98 22 0:52 / /mnt/nas\\040share rw,relatime shared:50 - nfs4 nas:/volume1 rw",
        "120 22 0:60 /volume1/unifi /archive ro,relatime - cifs //nas/unifi ro",
      ].join("\n"),
    );
    expect([...points]).toEqual(["/", "/mnt/nas share", "/archive"]);
  });

  it("knows a real mount point from a plain directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "unifi-archive-mount-"));
    afterAll(() => rm(dir, { recursive: true, force: true }));
    expect(await isMountPoint("/")).toBe(true);
    expect(await isMountPoint(dir)).toBe(false);
  });

  // In a container, /archive is always a (bind) mount point; only its file system type tells
  // whether the NAS was mounted on the host when the container started.
  const DOCKER_NAS = [
    "500 400 0:90 / / rw,relatime - overlay overlay rw",
    "510 500 0:52 /unifi /archive ro,relatime master:50 - nfs4 nas:/volume1 ro",
  ].join("\n");
  const DOCKER_EMPTY_DIR = [
    "500 400 0:90 / / rw,relatime - overlay overlay rw",
    "510 500 8:1 /mnt/nas/unifi /archive ro,relatime - ext4 /dev/sda1 rw",
  ].join("\n");

  it("finds the file system a directory lies on", () => {
    expect(parseMountInfo(DOCKER_NAS)).toEqual([
      { mountPoint: "/", fsType: "overlay" },
      { mountPoint: "/archive", fsType: "nfs4" },
    ]);
    expect(findContainingMount(parseMountInfo(DOCKER_NAS), "/archive/2026-10-09")?.fsType).toBe("nfs4");
    expect(findContainingMount(parseMountInfo(DOCKER_EMPTY_DIR), "/archive")?.fsType).toBe("ext4");
    expect(findContainingMount(parseMountInfo(DOCKER_NAS), "/archived")?.fsType).toBe("overlay");
  });

  it("checks ARCHIVE_REQUIRED_FS_TYPE against the real mount table", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "unifi-archive-fstype-"));
    afterAll(() => rm(dir, { recursive: true, force: true }));
    const { readFile, realpath } = await import("node:fs/promises");
    const own = findContainingMount(parseMountInfo(await readFile("/proc/self/mountinfo", "utf8")), await realpath(dir))!.fsType;

    await expect(assertFileSystemType(dir, ["nfs4", own.toUpperCase()])).resolves.toBeUndefined();
    await expect(assertFileSystemType(dir, ["nfs4", "cifs"])).rejects.toThrow(
      `ARCHIVE_ROOT is on a "${own}" file system, expected nfs4 or cifs (ARCHIVE_REQUIRED_FS_TYPE): the NAS is not mounted`,
    );
    await expect(assertFileSystemType(path.join(dir, "gone"), ["nfs4"])).rejects.toThrow("cannot be checked (ENOENT)");
    expect(parseFileSystemTypes("")).toBeNull();
    expect(parseFileSystemTypes("nfs,nfs4")).toEqual(["nfs", "nfs4"]);
  });
});

describe("status message sanitizing", () => {
  it("removes secrets, credentials and internal paths", () => {
    expect(
      sanitizeStatusMessage("failed for key abc-SECRET-123 at postgresql://user:pw@db/x", { secrets: ["abc-SECRET-123"] }),
    ).toBe("failed for key *** at postgresql://***@db/x");
    expect(sanitizeStatusMessage("EACCES: permission denied, opendir '/srv/nas/unifi/2026-10-09'", { archiveRoot: "/srv/nas/unifi" })).toBe(
      "EACCES: permission denied, opendir 'ARCHIVE_ROOT/2026-10-09'",
    );
    expect(sanitizeStatusMessage("cannot open /var/lib/secret/file")).toBe("cannot open <Pfad>");
    expect(sanitizeStatusMessage("Protect rejected the API key (HTTP 401 for /proxy/protect/integration/v1/meta/info).")).toContain(
      "/proxy/protect/integration/v1/meta/info",
    );
    expect(sanitizeStatusMessage("x".repeat(1000))).toHaveLength(400);
  });
});
