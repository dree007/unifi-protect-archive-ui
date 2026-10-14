import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, type PoolClient } from "pg";

import type { ProtectDetails, ProtectState } from "@/domain/background";
import { findPgError } from "@/server/db/errors";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/types";

import type { WorkerConfig } from "./config";
import { createReconcileJob, createScanJob, type JobContext, type JobStates } from "./jobs";
import { LeadershipLostError, LeadershipSession } from "./leadership";
import { silentWorkerLogger, withPrefix, type WorkerLogger } from "./logger";
import { runProtect, type ProtectRunnerOptions } from "./protect-runner";
import { describeError, sanitizeStatusMessage } from "./sanitize";
import { Mutex, PeriodicJob } from "./scheduler";
import { DB_NOW, StatusStore } from "./status";

/**
 * The self-hosted background worker (docs/background-worker.md): one long-running process
 * that keeps the archive up to date – Protect event stream, periodic NAS scan, periodic
 * reconciliation, heartbeat. Opens no ports; talks only to PostgreSQL, the NAS (read-only)
 * and Protect (read-only).
 *
 * Start-up: database → worker lock → status takeover → heartbeat → Protect (in the background)
 * → NAS scan (if WORKER_RUN_ON_STARTUP) → reconciliation → regular operation. Protect and the
 * scanner never wait for each other.
 *
 * Ends when `signal` aborts (exit code 0) or – fail-closed – as soon as exclusivity may be lost
 * (exit code 1); a container restart policy then starts a fresh instance.
 */

export interface WorkerOptions {
  config: WorkerConfig;
  signal: AbortSignal;
  logger?: WorkerLogger;
  instanceId?: string;
  /** Upper bound for finishing a running job on shutdown (default 25 s). */
  shutdownTimeoutMs?: number;
  /** Waiting for the database at start-up (default 30 × 2 s). */
  databaseAttempts?: number;
  databaseRetryDelayMs?: number;
  scanOverrides?: JobContext["scanOverrides"];
  matchingConfig?: JobContext["matchingConfig"];
  protectOverrides?: Partial<
    Pick<ProtectRunnerOptions, "authRetryMs" | "errorRetryMs" | "collectorBusyRetryMs" | "backoff" | "heartbeatIntervalMs" | "httpTimeoutMs">
  >;
  /** Test hook: called once regular operation started. */
  onRunning?: (handle: { instanceId: string; scan: PeriodicJob; reconcile: PeriodicJob }) => void;
}

export interface WorkerResult {
  exitCode: 0 | 1;
  /** Why the worker ended; set for exit code 1. */
  error?: string;
}

/** Start-up failed before the worker did anything (database unreachable, schema missing). */
export class WorkerStartupError extends Error {
  override name = "WorkerStartupError";
}

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const { config, signal, logger = silentWorkerLogger, shutdownTimeoutMs = 25_000 } = options;
  const instanceId = options.instanceId ?? randomUUID();
  // The database password may come from the URL or – as in compose.yaml – from PGPASSWORD.
  const secrets = [
    config.protect.mode === "enabled" ? config.protect.config.apiKey : undefined,
    passwordOf(config.databaseUrl),
    process.env.PGPASSWORD,
  ];
  const sanitize = (message: string) => sanitizeStatusMessage(message, { archiveRoot: config.archiveRoot, secrets });

  // Internal stop: external signal, or fail-closed when exclusivity is lost.
  const stop = new AbortController();
  let lostError: LeadershipLostError | undefined;
  const failClosed = (error: unknown) => {
    if (lostError || stop.signal.aborted) return;
    lostError = error instanceof LeadershipLostError ? error : new LeadershipLostError(describeError(error));
    logger.error(`${lostError.message} Stopping all work (fail-closed).`);
    stop.abort();
  };
  const onExternalAbort = () => stop.abort();
  signal.addEventListener("abort", onExternalAbort, { once: true });

  const pool = new Pool({ connectionString: config.databaseUrl, application_name: "unifi-archive-worker" });
  // Idle pool connections dropped by a server restart must not crash the process; the
  // leadership session decides whether the worker can go on.
  pool.on("error", (error) => logger.warn(`Database connection dropped: ${sanitize(error.message)}`));
  const db = drizzle({ client: pool, schema }) as Database;
  let leadership: LeadershipSession | undefined;
  const backends = new Map<PoolClient, number>();
  pool.on("connect", (client) => {
    void client.query<{ pid: number }>("select pg_backend_pid() as pid")
      .then(({ rows }) => backends.set(client, rows[0].pid)).catch(() => {});
  });
  pool.on("remove", (client) => backends.delete(client));
  let cancellation = Promise.resolve();
  const cancelWork = () => {
    const pids = [...backends.values(), leadership?.backendPid].filter((pid): pid is number => !!pid);
    if (!pids.length) return;
    // A disconnected client may remain blocked server-side until its query ends.
    // Cancel only this instance's known sessions before closing connections/locks.
    cancellation = (async () => {
      const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1_000, query_timeout: 1_000, application_name: "unifi-archive-worker-shutdown" });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.query("select pg_cancel_backend(pid) from pg_stat_activity where datname = current_database() and usename = current_user and pid = any($1::integer[])", [pids]);
      } finally { await client.end().catch(() => {}); }
    })().catch(() => logger.warn("Database work could not be canceled during shutdown; bounded exit/recovery still applies."));
  };
  stop.signal.addEventListener("abort", cancelWork, { once: true });

  try {
    await waitForDatabase(pool, options, logger, signal);
    if (signal.aborted) return { exitCode: 0 };

    leadership = await LeadershipSession.acquire({ databaseUrl: config.databaseUrl, instanceId, onLost: failClosed });
    logger.info(`Worker lock acquired (instance ${instanceId}).`);

    const status = new StatusStore(db, instanceId);
    const protect = initialProtectState(config);
    try {
      await status.takeOver(protect);
    } catch (error) {
      if (findPgError(error)?.code === "42P01") {
        throw new WorkerStartupError("The database schema is missing or outdated. Run `npm run db:migrate` first.");
      }
      throw error;
    }
    const states: JobStates = {
      archiveScan: (await status.read("archiveScan"))?.state as JobStates["archiveScan"],
      reconciliation: (await status.read("reconciliation"))?.state as JobStates["reconciliation"],
    };

    const heartbeat = runHeartbeat(leadership, config.heartbeatIntervalMs, stop.signal);

    const protectRun =
      config.protect.mode === "enabled"
        ? runProtect({
            config: config.protect.config,
            db,
            leadership,
            status,
            logger: withPrefix(logger, "[protect]"),
            signal: stop.signal,
            onLeadershipLost: failClosed,
            ...options.protectOverrides,
          })
        : Promise.resolve();
    if (config.protect.mode === "disabled") {
      logger.info(`UniFi Protect disabled (${config.protect.reason === "switchedOff" ? "PROTECT_COLLECTOR_ENABLED=false" : "not configured"}).`);
    } else if (config.protect.mode === "misconfigured") {
      logger.error(`UniFi Protect is incompletely configured and stays off: ${config.protect.message}`);
    }

    // NAS scan and reconciliation share a mutex: never at the same time; a reconciliation that
    // becomes due during a scan runs once right after it.
    const context: JobContext = {
      config,
      db,
      leadership,
      status,
      logger: withPrefix(logger, "[archive]"),
      scanOverrides: options.scanOverrides,
      matchingConfig: options.matchingConfig,
    };
    const mutex = new Mutex();
    const scheduleWriter = (component: "archiveScan" | "reconciliation") => (nextRunAt: Date) => {
      status.update(component, { nextRunAt }).catch(onJobError);
    };
    const onJobError = (error: unknown) => {
      if (error instanceof LeadershipLostError) failClosed(error);
      else logger.error(`Job failed unexpectedly: ${sanitize(describeError(error))}`);
    };
    const reconcile = new PeriodicJob({
      name: "reconciliation",
      intervalMs: config.reconcileIntervalMs,
      firstRun: "afterInterval",
      mutex,
      run: createReconcileJob(context, states),
      onScheduled: scheduleWriter("reconciliation"),
      onError: onJobError,
    });
    const scan = new PeriodicJob({
      name: "archiveScan",
      intervalMs: config.scanIntervalMs,
      firstRun: config.runOnStartup ? "immediately" : "afterInterval",
      mutex,
      // After every scan (new clips may have been indexed even by a failed one).
      run: createScanJob(context, states, () => reconcile.trigger()),
      onScheduled: scheduleWriter("archiveScan"),
      onError: onJobError,
    });
    const loops = [scan.start(stop.signal), reconcile.start(stop.signal)];

    await status.update("worker", { state: "running" });
    logger.info(
      `Worker running: NAS scan every ${minutes(config.scanIntervalMs)}, reconciliation every ${minutes(config.reconcileIntervalMs)}, ` +
        `heartbeat every ${config.heartbeatIntervalMs / 1000} s${config.runOnStartup ? ", start-up scan now" : ""}.`,
    );
    options.onRunning?.({ instanceId, scan, reconcile });

    // --- regular operation until stopped -----------------------------------------------------
    await new Promise<void>((resolve) => {
      if (stop.signal.aborted) resolve();
      else stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    // --- shutdown ----------------------------------------------------------------------------
    if (!lostError) {
      logger.info("Shutting down: no new jobs; waiting for running work...");
      await status.update("worker", { state: "stopping" }).catch(() => {});
    }
    const finished = await settleWithin(Promise.allSettled([...loops, protectRun, heartbeat]), shutdownTimeoutMs);
    if (!finished) logger.warn(`Running work did not finish within ${shutdownTimeoutMs / 1000} s; stopping anyway.`);

    if (lostError) {
      // Usually fails (the rows belong to another instance or the database is gone) – then
      // the stale heartbeat tells the truth.
      await status.update("worker", { state: "error", lastFailedAt: DB_NOW, lastErrorMessage: sanitize(lostError.message) }).catch(() => {});
      return { exitCode: 1, error: lostError.message };
    }
    if (config.protect.mode === "enabled") await status.update("protect", { state: "stopped" }).catch(() => {});
    await status.update("worker", { state: "stopped" }).catch(() => {});
    logger.info("Worker stopped.");
    return { exitCode: 0 };
  } finally {
    signal.removeEventListener("abort", onExternalAbort);
    stop.abort();
    await cancellation;
    stop.signal.removeEventListener("abort", cancelWork);
    await leadership?.release();
    await pool.end().catch(() => {});
  }
}

function initialProtectState(config: WorkerConfig): { protectState: ProtectState; protectDetails: ProtectDetails; protectError: string | null } {
  switch (config.protect.mode) {
    case "disabled":
      return { protectState: "disabled", protectDetails: { disabledReason: config.protect.reason }, protectError: null };
    case "misconfigured":
      return { protectState: "error", protectDetails: {}, protectError: `Incomplete configuration: ${config.protect.message}` };
    case "enabled":
      return { protectState: "connecting", protectDetails: {}, protectError: null };
  }
}

async function waitForDatabase(pool: Pool, options: WorkerOptions, logger: WorkerLogger, signal: AbortSignal): Promise<void> {
  const { databaseAttempts = 30, databaseRetryDelayMs = 2000 } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      if (attempt >= databaseAttempts || signal.aborted) {
        throw new WorkerStartupError(`Database not reachable: ${describeError(error)}`, { cause: error });
      }
      if (attempt === 1) logger.warn("Database not reachable yet; waiting...");
      await sleep(databaseRetryDelayMs, undefined, { signal }).catch(() => {});
    }
  }
}

/** Heartbeat loop; a failed heartbeat ends the worker via the leadership session (fail-closed). */
async function runHeartbeat(leadership: LeadershipSession, intervalMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(intervalMs, undefined, { signal }).catch(() => {});
    if (signal.aborted) return;
    try {
      await leadership.heartbeat();
    } catch {
      return;
    }
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = new AbortController();
  const timer = sleep(timeoutMs, false, { signal: timeout.signal }).catch(() => false);
  const result = await Promise.race([promise.then(() => true), timer]);
  timeout.abort();
  return result;
}

function minutes(ms: number): string {
  const value = ms / 60_000;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} min`;
}

function passwordOf(databaseUrl: string): string | undefined {
  try {
    return decodeURIComponent(new URL(databaseUrl).password) || undefined;
  } catch {
    return undefined;
  }
}
