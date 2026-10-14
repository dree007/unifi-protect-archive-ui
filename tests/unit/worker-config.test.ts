import { describe, expect, it } from "vitest";

import { parseInterval, readHeartbeatStaleMs, readWorkerConfig, resolveProtectSetting, WorkerConfigError } from "@/server/worker/config";

const BASE = {
  DATABASE_URL: "postgresql://user:secret@localhost:5432/unifi_archive",
  ARCHIVE_ROOT: "/archive",
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    readWorkerConfig(env);
  } catch (error) {
    if (error instanceof WorkerConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a WorkerConfigError");
}

describe("worker configuration", () => {
  it("uses the documented defaults", () => {
    const config = readWorkerConfig(BASE);
    expect(config).toMatchObject({
      archiveRoot: "/archive",
      archiveRequiredMount: null,
      archiveRequiredFsTypes: null,
      scanIntervalMs: 15 * 60_000,
      reconcileIntervalMs: 5 * 60_000,
      heartbeatIntervalMs: 30_000,
      heartbeatStaleMs: 90_000,
      runOnStartup: true,
      protect: { mode: "disabled", reason: "notConfigured" },
    });
  });

  it("accepts custom intervals, also fractional ones", () => {
    const config = readWorkerConfig({
      ...BASE,
      ARCHIVE_SCAN_INTERVAL_MINUTES: "60",
      ARCHIVE_RECONCILE_INTERVAL_MINUTES: "0.5",
      WORKER_HEARTBEAT_INTERVAL_SECONDS: " 10 ",
      WORKER_HEARTBEAT_STALE_SECONDS: "45",
      WORKER_RUN_ON_STARTUP: "false",
    });
    expect(config).toMatchObject({
      scanIntervalMs: 3_600_000,
      reconcileIntervalMs: 30_000,
      heartbeatIntervalMs: 10_000,
      heartbeatStaleMs: 45_000,
      runOnStartup: false,
    });
  });

  it.each([
    ["negative", "-5"],
    ["zero", "0"],
    ["text", "abc"],
    ["with unit", "15min"],
    ["exponent", "1e3"],
    ["too large", "20000"],
  ])("rejects a %s interval", (_, value) => {
    expect(problems({ ...BASE, ARCHIVE_SCAN_INTERVAL_MINUTES: value })).toEqual([
      expect.stringContaining("ARCHIVE_SCAN_INTERVAL_MINUTES must be a number of minutes"),
    ]);
  });

  it("treats empty values as unset", () => {
    expect(readWorkerConfig({ ...BASE, ARCHIVE_SCAN_INTERVAL_MINUTES: "", WORKER_RUN_ON_STARTUP: " " }).scanIntervalMs).toBe(900_000);
  });

  it("rejects an invalid boolean and a heartbeat that would look stale", () => {
    expect(problems({ ...BASE, WORKER_RUN_ON_STARTUP: "maybe" })).toEqual([expect.stringContaining("WORKER_RUN_ON_STARTUP")]);
    expect(problems({ ...BASE, WORKER_HEARTBEAT_INTERVAL_SECONDS: "60", WORKER_HEARTBEAT_STALE_SECONDS: "90" })).toEqual([
      expect.stringContaining("at least twice"),
    ]);
  });

  it("requires ARCHIVE_ROOT as an absolute path and reports all problems at once", () => {
    expect(problems({ DATABASE_URL: "", ARCHIVE_SCAN_INTERVAL_MINUTES: "x" })).toEqual([
      expect.stringContaining("DATABASE_URL is not set"),
      expect.stringContaining("ARCHIVE_ROOT is not set"),
      expect.stringContaining("ARCHIVE_SCAN_INTERVAL_MINUTES"),
    ]);
    expect(problems({ ...BASE, ARCHIVE_ROOT: "archive" })).toEqual([expect.stringContaining("absolute")]);
  });

  it("validates ARCHIVE_REQUIRED_MOUNT against ARCHIVE_ROOT", () => {
    expect(readWorkerConfig({ ...BASE, ARCHIVE_ROOT: "/mnt/nas/unifi", ARCHIVE_REQUIRED_MOUNT: "/mnt/nas" }).archiveRequiredMount).toBe("/mnt/nas");
    expect(readWorkerConfig({ ...BASE, ARCHIVE_REQUIRED_MOUNT: "/archive/" }).archiveRequiredMount).toBe("/archive");
    expect(problems({ ...BASE, ARCHIVE_REQUIRED_MOUNT: "/mnt/other" })).toEqual([expect.stringContaining("parent directory")]);
    expect(problems({ ...BASE, ARCHIVE_REQUIRED_MOUNT: "/archiveX" })).toEqual([expect.stringContaining("parent directory")]);
  });

  it("reads ARCHIVE_REQUIRED_FS_TYPE as a list of file system types", () => {
    expect(readWorkerConfig(BASE).archiveRequiredFsTypes).toBeNull();
    expect(readWorkerConfig({ ...BASE, ARCHIVE_REQUIRED_FS_TYPE: " nfs4 , cifs" }).archiveRequiredFsTypes).toEqual(["nfs4", "cifs"]);
    expect(readWorkerConfig({ ...BASE, ARCHIVE_REQUIRED_FS_TYPE: "fuse.sshfs" }).archiveRequiredFsTypes).toEqual(["fuse.sshfs"]);
    expect(problems({ ...BASE, ARCHIVE_REQUIRED_FS_TYPE: "nfs4; rm" })).toEqual([expect.stringContaining("ARCHIVE_REQUIRED_FS_TYPE")]);
  });

  it("never needs the configuration at import or build time", async () => {
    // Importing the worker modules reads nothing; only readWorkerConfig() does.
    await expect(import("@/server/worker/worker")).resolves.toBeDefined();
    expect(readHeartbeatStaleMs({ WORKER_HEARTBEAT_STALE_SECONDS: "garbage" })).toBe(90_000);
    expect(readHeartbeatStaleMs({ WORKER_HEARTBEAT_STALE_SECONDS: "120" })).toBe(120_000);
  });
});

describe("Protect setting", () => {
  const protect = { UNIFI_PROTECT_URL: "https://192.168.0.1", UNIFI_PROTECT_API_KEY: "key-123456" };

  it("auto: enabled with a complete configuration", () => {
    expect(resolveProtectSetting(protect)).toMatchObject({ mode: "enabled", config: { baseUrl: "https://192.168.0.1", tlsVerify: true } });
  });

  it("auto: not configured at all is a deliberate NAS-only setup", () => {
    expect(resolveProtectSetting({})).toEqual({ mode: "disabled", reason: "notConfigured" });
  });

  it("auto: a partial or invalid configuration is reported, not silently ignored", () => {
    expect(resolveProtectSetting({ UNIFI_PROTECT_URL: "https://192.168.0.1" })).toEqual({
      mode: "misconfigured",
      message: expect.stringContaining("UNIFI_PROTECT_API_KEY is not set"),
    });
    expect(resolveProtectSetting({ UNIFI_PROTECT_API_KEY: "key" })).toMatchObject({ mode: "misconfigured" });
    expect(resolveProtectSetting({ ...protect, UNIFI_PROTECT_URL: "ftp://x" })).toMatchObject({ mode: "misconfigured" });
  });

  it("false: disabled even with credentials", () => {
    expect(resolveProtectSetting({ ...protect, PROTECT_COLLECTOR_ENABLED: "false" })).toEqual({ mode: "disabled", reason: "switchedOff" });
  });

  it("true: missing credentials are a configuration error", () => {
    expect(resolveProtectSetting({ ...protect, PROTECT_COLLECTOR_ENABLED: "true" })).toMatchObject({ mode: "enabled" });
    expect(problems({ ...BASE, PROTECT_COLLECTOR_ENABLED: "true" })).toEqual([
      expect.stringContaining("PROTECT_COLLECTOR_ENABLED=true, but UNIFI_PROTECT_URL is not set"),
    ]);
    expect(problems({ ...BASE, PROTECT_COLLECTOR_ENABLED: "sometimes" })).toEqual([expect.stringContaining('"auto", "true" or "false"')]);
  });

  it("never puts the API key into an error", () => {
    const messages = problems({ ...BASE, PROTECT_COLLECTOR_ENABLED: "true", UNIFI_PROTECT_URL: "nonsense", UNIFI_PROTECT_API_KEY: "super-secret-key" });
    expect(messages.join(" ")).not.toContain("super-secret-key");
  });
});

describe("parseInterval", () => {
  it("returns the default for unset values", () => {
    expect(parseInterval("X", undefined, { defaultValue: 7, min: 1, max: 10, unit: "s" })).toBe(7);
  });
});
