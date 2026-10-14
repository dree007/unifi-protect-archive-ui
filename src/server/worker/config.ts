import path from "node:path";

import { parseFileSystemTypes } from "@/server/archive/mount-check";
import { readDatabaseUrl } from "@/server/db/client";
import { ProtectConfigError, readProtectConfig, type ProtectConfig } from "@/server/protect/config";

/**
 * Configuration of the background worker (docs/background-worker.md). Read and validated when
 * the worker starts – never at import or build time. All problems are collected and reported
 * together, so a misconfigured container needs only one restart to fix.
 */

type Env = Record<string, string | undefined>;

export const WORKER_DEFAULTS = {
  scanIntervalMinutes: 15,
  reconcileIntervalMinutes: 5,
  heartbeatIntervalSeconds: 30,
  heartbeatStaleSeconds: 90,
  runOnStartup: true,
} as const;

/** UniFi Protect is optional; `misconfigured` keeps the worker running without it. */
export type ProtectSetting =
  | { mode: "disabled"; reason: "switchedOff" | "notConfigured" }
  | { mode: "enabled"; config: ProtectConfig }
  | { mode: "misconfigured"; message: string };

export interface WorkerConfig {
  databaseUrl: string;
  /** Absolute; existence is checked by every scan (the NAS may come and go). */
  archiveRoot: string;
  /** Optional mount point (ARCHIVE_ROOT or an ancestor) that must be mounted for a scan. */
  archiveRequiredMount: string | null;
  /** Optional file system types ARCHIVE_ROOT must lie on (ARCHIVE_REQUIRED_FS_TYPE, e.g. nfs4). */
  archiveRequiredFsTypes: string[] | null;
  scanIntervalMs: number;
  reconcileIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  runOnStartup: boolean;
  protect: ProtectSetting;
}

/** Invalid worker configuration: the worker does not start (exit code 2). */
export class WorkerConfigError extends Error {
  override name = "WorkerConfigError";
  constructor(readonly problems: string[]) {
    super(`Invalid worker configuration:\n- ${problems.join("\n- ")}`);
  }
}

const NUMBER = /^\d+(\.\d+)?$/;

/**
 * A positive number within bounds; unset or blank → default. Decimals are allowed (e.g. 0.5
 * minutes for tests); zero, negative values, units ("15min") and other text are rejected.
 */
export function parseInterval(
  name: string,
  raw: string | undefined,
  { defaultValue, min, max, unit }: { defaultValue: number; min: number; max: number; unit: string },
): number {
  const value = raw?.trim();
  if (!value) return defaultValue;
  const parsed = NUMBER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number of ${unit} between ${min} and ${max}, got "${raw}".`);
  }
  return parsed;
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

export function parseBoolean(name: string, raw: string | undefined, defaultValue: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}".`);
}

/**
 * PROTECT_COLLECTOR_ENABLED: `false` switches Protect off, `true` requires a complete Protect
 * configuration, `auto` (default) uses Protect when it is configured. In `auto`, nothing set
 * means "not configured" (fine: NAS-only operation); a partial or invalid configuration is
 * reported as misconfiguration – it is neither silently ignored nor half started.
 */
export function resolveProtectSetting(env: Env): ProtectSetting {
  const mode = env.PROTECT_COLLECTOR_ENABLED?.trim().toLowerCase() || "auto";
  if (FALSE.has(mode)) return { mode: "disabled", reason: "switchedOff" };
  if (TRUE.has(mode)) {
    try {
      return { mode: "enabled", config: readProtectConfig(env) };
    } catch (error) {
      if (error instanceof ProtectConfigError) {
        throw new Error(`PROTECT_COLLECTOR_ENABLED=true, but ${error.message}`);
      }
      throw error;
    }
  }
  if (mode !== "auto") {
    throw new Error(`PROTECT_COLLECTOR_ENABLED must be "auto", "true" or "false", got "${env.PROTECT_COLLECTOR_ENABLED}".`);
  }
  if (!env.UNIFI_PROTECT_URL?.trim() && !env.UNIFI_PROTECT_API_KEY?.trim()) {
    return { mode: "disabled", reason: "notConfigured" };
  }
  try {
    return { mode: "enabled", config: readProtectConfig(env) };
  } catch (error) {
    if (error instanceof ProtectConfigError) return { mode: "misconfigured", message: error.message };
    throw error;
  }
}

/** Stale threshold of the heartbeat; also read by the system page (falls back to the default). */
export function readHeartbeatStaleMs(env: Env = process.env): number {
  try {
    return heartbeatStaleSeconds(env) * 1000;
  } catch {
    return WORKER_DEFAULTS.heartbeatStaleSeconds * 1000;
  }
}

const heartbeatStaleSeconds = (env: Env) =>
  parseInterval("WORKER_HEARTBEAT_STALE_SECONDS", env.WORKER_HEARTBEAT_STALE_SECONDS, {
    defaultValue: WORKER_DEFAULTS.heartbeatStaleSeconds,
    min: 1,
    max: 86_400,
    unit: "seconds",
  });

function readArchiveRoot(env: Env): { archiveRoot: string; archiveRequiredMount: string | null } {
  const root = env.ARCHIVE_ROOT?.trim();
  if (!root) throw new Error("ARCHIVE_ROOT is not set. Set it to the absolute path of the mounted UniFi archive.");
  if (!path.isAbsolute(root)) throw new Error(`ARCHIVE_ROOT must be an absolute path, got "${root}".`);
  const archiveRoot = path.resolve(root);

  const mount = env.ARCHIVE_REQUIRED_MOUNT?.trim();
  if (!mount) return { archiveRoot, archiveRequiredMount: null };
  if (!path.isAbsolute(mount)) throw new Error(`ARCHIVE_REQUIRED_MOUNT must be an absolute path, got "${mount}".`);
  const archiveRequiredMount = path.resolve(mount);
  const relative = path.relative(archiveRequiredMount, archiveRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ARCHIVE_REQUIRED_MOUNT must be ARCHIVE_ROOT itself or a parent directory of it.");
  }
  return { archiveRoot, archiveRequiredMount };
}

export function readWorkerConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const read = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const databaseUrl = read(() => readDatabaseUrl(env.DATABASE_URL));
  const archive = read(() => readArchiveRoot(env));
  const requiredFsTypes = read(() => parseFileSystemTypes(env.ARCHIVE_REQUIRED_FS_TYPE));
  const scanMinutes = read(() =>
    parseInterval("ARCHIVE_SCAN_INTERVAL_MINUTES", env.ARCHIVE_SCAN_INTERVAL_MINUTES, {
      defaultValue: WORKER_DEFAULTS.scanIntervalMinutes,
      min: 0.01,
      max: 10_080,
      unit: "minutes",
    }),
  );
  const reconcileMinutes = read(() =>
    parseInterval("ARCHIVE_RECONCILE_INTERVAL_MINUTES", env.ARCHIVE_RECONCILE_INTERVAL_MINUTES, {
      defaultValue: WORKER_DEFAULTS.reconcileIntervalMinutes,
      min: 0.01,
      max: 10_080,
      unit: "minutes",
    }),
  );
  const heartbeatSeconds = read(() =>
    parseInterval("WORKER_HEARTBEAT_INTERVAL_SECONDS", env.WORKER_HEARTBEAT_INTERVAL_SECONDS, {
      defaultValue: WORKER_DEFAULTS.heartbeatIntervalSeconds,
      min: 1,
      max: 3600,
      unit: "seconds",
    }),
  );
  const staleSeconds = read(() => heartbeatStaleSeconds(env));
  const runOnStartup = read(() => parseBoolean("WORKER_RUN_ON_STARTUP", env.WORKER_RUN_ON_STARTUP, WORKER_DEFAULTS.runOnStartup));
  const protect = read(() => resolveProtectSetting(env));

  if (heartbeatSeconds !== undefined && staleSeconds !== undefined && staleSeconds < 2 * heartbeatSeconds) {
    problems.push(
      `WORKER_HEARTBEAT_STALE_SECONDS (${staleSeconds}) must be at least twice WORKER_HEARTBEAT_INTERVAL_SECONDS (${heartbeatSeconds}), ` +
        "otherwise a healthy worker can look stale.",
    );
  }
  if (problems.length > 0) throw new WorkerConfigError(problems);

  return {
    databaseUrl: databaseUrl!,
    archiveRoot: archive!.archiveRoot,
    archiveRequiredMount: archive!.archiveRequiredMount,
    archiveRequiredFsTypes: requiredFsTypes!,
    scanIntervalMs: Math.round(scanMinutes! * 60_000),
    reconcileIntervalMs: Math.round(reconcileMinutes! * 60_000),
    heartbeatIntervalMs: Math.round(heartbeatSeconds! * 1000),
    heartbeatStaleMs: Math.round(staleSeconds! * 1000),
    runOnStartup: runOnStartup!,
    protect: protect!,
  };
}
