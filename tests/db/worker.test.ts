import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import type { Database } from "@/server/db/types";
import { upsertCameras } from "@/server/repositories/cameras";
import type { WorkerConfig } from "@/server/worker/config";
import { WorkerAlreadyRunningError } from "@/server/worker/leadership";
import type { WorkerLogger } from "@/server/worker/logger";
import { runWorker, type WorkerOptions, type WorkerResult } from "@/server/worker/worker";

import { clipPath, createTempArchive, type TempArchive } from "../support/archive-fixture";
import { eventMessage, FAKE_API_KEY, FakeProtect } from "../support/fake-protect";
import { createIsolatedDb } from "./helpers";
import { integrity, snapshot } from "./reconcile-world";

const GARDEN = "660000000000000000000001";
const T = (minute: number, second = 0) => new Date(Date.UTC(2026, 7, 10, 8, minute, second));

/** Garden + Driveway at the same time (one multi-camera event), Doorbell alone. */
async function archiveWithClips(): Promise<TempArchive> {
  const archive = await createTempArchive();
  await archive.addFile(clipPath("Garden", T(0), 30), { size: 500 });
  await archive.addFile(clipPath("Driveway", T(0, 1), 30), { size: 500 });
  await archive.addFile(clipPath("Doorbell", T(20), 15), { size: 500 });
  return archive;
}

function recordingLogger() {
  const lines: string[] = [];
  const logger: WorkerLogger = {
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
    debug: () => {},
  };
  return { logger, lines };
}

async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type StatusRows = Record<string, { state: string; instance_id: string; last_error_message: string | null; details: Record<string, unknown> | null }>;

async function statusRows(db: Database): Promise<StatusRows> {
  const result = await db.execute<{ component: string; state: string; instance_id: string; last_error_message: string | null; details: Record<string, unknown> | null }>(
    sql`select component, state, instance_id, last_error_message, details from background_component_status`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.component, row]));
}

const state = async (db: Database, component: string) => (await statusRows(db))[component]?.state;

/** Starts a worker in-process; `stop()` = SIGTERM. */
function startWorker(options: { url: string; archiveRoot: string } & Partial<Omit<WorkerConfig, "databaseUrl" | "archiveRoot">> & Partial<WorkerOptions>) {
  const { url, archiveRoot, protect = { mode: "disabled", reason: "notConfigured" }, ...rest } = options;
  const config: WorkerConfig = {
    databaseUrl: url,
    archiveRoot,
    archiveRequiredMount: null,
    archiveRequiredFsTypes: null,
    scanIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    heartbeatIntervalMs: 200,
    heartbeatStaleMs: 1000,
    runOnStartup: true,
    protect,
    ...(rest as Partial<WorkerConfig>),
  };
  const controller = new AbortController();
  const { logger, lines } = recordingLogger();
  let handle: Parameters<NonNullable<WorkerOptions["onRunning"]>>[0] | undefined;
  const run: Promise<WorkerResult> = runWorker({
    config,
    signal: controller.signal,
    logger,
    shutdownTimeoutMs: 10_000,
    databaseAttempts: 1,
    protectOverrides: { backoff: { initialMs: 20, maxMs: 100, jitterRatio: 0 }, heartbeatIntervalMs: 1000, httpTimeoutMs: 2000, ...rest.protectOverrides },
    onRunning: (h) => (handle = h),
    ...(rest as Partial<WorkerOptions>),
  });
  return {
    run,
    lines,
    get handle() {
      return handle;
    },
    stop: async () => {
      controller.abort();
      return run;
    },
  };
}

describe("background worker", () => {
  it("full cycle with Protect: scan, camera sync, live event, reconciliation, status, shutdown, restart without duplicates", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const protect = await FakeProtect.start();
    const connected = protect.nextConnection();
    const worker = startWorker({
      url,
      archiveRoot: archive.root,
      scanIntervalMs: 1500,
      reconcileIntervalMs: 700,
      protect: { mode: "enabled", config: protect.config() },
    });

    // Registers, heartbeats, scans, syncs cameras, connects.
    await waitFor(async () => (await state(db, "worker")) === "running");
    await connected;
    await waitFor(async () => (await state(db, "protect")) === "connected");
    await waitFor(async () => (await state(db, "archiveScan")) === "success");
    const status = await statusRows(db);
    expect(status.protect.details).toEqual({ cameraCount: 6 });
    const firstBeat = await db.execute<{ at: Date }>(sql`select heartbeat_at as at from background_component_status where component = 'worker'`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const laterBeat = await db.execute<{ at: Date }>(sql`select heartbeat_at as at from background_component_status where component = 'worker'`);
    expect(new Date(laterBeat.rows[0].at).getTime()).toBeGreaterThan(new Date(firstBeat.rows[0].at).getTime());

    // A live Protect event for the Garden clip arrives.
    const eventId = randomUUID();
    protect.broadcast(eventMessage("finalUpdate", { id: eventId, device: GARDEN, start: T(0, 2).getTime(), end: T(0, 20).getTime() }));
    await waitFor(async () => (await db.execute(sql`select 1 from protect_events where protect_event_id = ${eventId}`)).rows.length === 1);

    // The regular reconciliation picks it up: one multi-camera event (metadata + temporal fallback).
    const events = await waitFor(async () => {
      const current = await snapshot(db);
      return current.some((event) => event.status === "matched") ? current : undefined;
    });
    expect(events.map(({ status, clips, protect: pe }) => ({ status, clips, protect: pe }))).toEqual([
      { status: "matched", clips: ["Driveway 08:00:01", "Garden 08:00:00"], protect: ["Garden person 08:00:02"] },
      { status: "archiveOnly", clips: ["Doorbell 08:20:00"], protect: [] },
    ]);

    // Further scans and reconciliations change nothing.
    const scans = worker.handle!.scan.completedRuns;
    await waitFor(() => worker.handle!.scan.completedRuns >= scans + 1 && worker.handle!.reconcile.completedRuns >= 3);
    expect(await snapshot(db)).toEqual(events);
    expect(await integrity(db)).toEqual({ clips: 3, clip_links: 3, protect: 1, protect_links: 1, empty: 0 });
    const rows = await statusRows(db);
    expect(rows.reconciliation).toMatchObject({ state: expect.stringMatching(/success|running/) });
    expect(rows.worker.state).toBe("running");

    // SIGTERM: everything stops, status says so.
    expect(await worker.stop()).toEqual({ exitCode: 0 });
    const stopped = await statusRows(db);
    expect(stopped.worker.state).toBe("stopped");
    expect(stopped.protect.state).toBe("stopped");
    expect(protect.sockets.size).toBe(0);

    // Restart: a new instance takes over; still no duplicates.
    const again = startWorker({ url, archiveRoot: archive.root, scanIntervalMs: 1500, reconcileIntervalMs: 700, protect: { mode: "enabled", config: protect.config() } });
    await waitFor(async () => (await state(db, "protect")) === "connected");
    await waitFor(() => (again.handle?.reconcile.completedRuns ?? 0) >= 2);
    const restarted = await statusRows(db);
    expect(restarted.worker.instance_id).not.toBe(stopped.worker.instance_id);
    expect(Object.values(restarted).every((row) => row.instance_id === restarted.worker.instance_id)).toBe(true);
    expect(await snapshot(db)).toEqual(events);
    expect(await integrity(db)).toEqual({ clips: 3, clip_links: 3, protect: 1, protect_links: 1, empty: 0 });
    expect((await db.execute(sql`select count(*)::int as n from archive_scan_runs where status = 'running'`)).rows[0]).toEqual({ n: 0 });
    expect(await again.stop()).toEqual({ exitCode: 0 });
  });

  it("works without Protect: NAS scan + temporal fallback only, Protect shown as disabled", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    // Cameras known from an earlier Protect sync (the fallback needs resolved cameras).
    await upsertCameras(
      ["Garden", "Driveway", "Doorbell"].map((name, index) => ({ protectDeviceId: `65000000000000000000000${index}`, name, state: "offline" as const })),
      db,
    );
    const worker = startWorker({ url, archiveRoot: archive.root });
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    const rows = await statusRows(db);
    expect(rows.protect).toMatchObject({ state: "disabled", details: { disabledReason: "notConfigured" }, last_error_message: null });
    expect((await snapshot(db)).map(({ status, clips }) => ({ status, clips }))).toEqual([
      { status: "archiveOnly", clips: ["Driveway 08:00:01", "Garden 08:00:00"] },
      { status: "archiveOnly", clips: ["Doorbell 08:20:00"] },
    ]);
    expect(await worker.stop()).toEqual({ exitCode: 0 });
    // Disabled stays disabled after shutdown (it is a configuration fact).
    expect(await state(db, "protect")).toBe("disabled");
  });

  it("without Protect and without any known camera: every clip becomes its own archive event", async () => {
    // Existing matching rule (docs/event-matching.md): the temporal fallback only joins clips of
    // resolved, different cameras – camera names alone are not trusted.
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const worker = startWorker({ url, archiveRoot: archive.root });
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    expect((await snapshot(db)).map(({ status, clips }) => ({ status, clips }))).toEqual([
      { status: "archiveOnly", clips: ["Garden 08:00:00"] },
      { status: "archiveOnly", clips: ["Driveway 08:00:01"] },
      { status: "archiveOnly", clips: ["Doorbell 08:20:00"] },
    ]);
    await worker.stop();
  });

  it("without start-up run: no scan at start, heartbeat and status still work", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const worker = startWorker({ url, archiveRoot: archive.root, runOnStartup: false, scanIntervalMs: 60_000 });
    await waitFor(async () => (await state(db, "worker")) === "running");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await state(db, "archiveScan")).toBe("idle");
    expect((await db.execute(sql`select count(*)::int as n from archive_scan_runs`)).rows[0]).toEqual({ n: 0 });
    const next = await db.execute<{ in_s: number }>(
      sql`select extract(epoch from next_run_at - now())::int as in_s from background_component_status where component = 'archiveScan'`,
    );
    expect(Number(next.rows[0].in_s)).toBeGreaterThan(50);
    await worker.stop();
  });

  it("a misconfigured Protect (auto) is reported, while the NAS side keeps working", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const worker = startWorker({ url, archiveRoot: archive.root, protect: { mode: "misconfigured", message: "UNIFI_PROTECT_API_KEY is not set." } });
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    expect((await statusRows(db)).protect).toMatchObject({ state: "error", last_error_message: expect.stringContaining("Incomplete configuration") });
    await worker.stop();
  });

  it("NAS unavailable: the scan fails and is retried later; reconciliation and Protect go on", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const protect = await FakeProtect.start();
    const worker = startWorker({
      url,
      archiveRoot: `${archive.root}/not-mounted`,
      scanIntervalMs: 400,
      reconcileIntervalMs: 300,
      protect: { mode: "enabled", config: protect.config() },
    });
    await waitFor(async () => (await state(db, "protect")) === "connected");
    await waitFor(() => (worker.handle?.scan.completedRuns ?? 0) >= 2);
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    const rows = await statusRows(db);
    expect(rows.archiveScan).toMatchObject({ state: "error", last_error_message: "ARCHIVE_ROOT does not exist (is the NAS mounted?)." });
    expect(rows.protect.state).toBe("connected");
    expect(rows.worker.state).toBe("running");
    // No retry storm: one scan per interval.
    const runs = (await db.execute<{ n: number }>(sql`select count(*)::int as n from archive_scan_runs`)).rows[0].n;
    expect(runs).toBeLessThanOrEqual(worker.handle!.scan.completedRuns + 1);
    await worker.stop();
  });

  it("a failing reconciliation is recorded and the next run recovers", async () => {
    const { db, url, pool } = await createIsolatedDb();
    const archive = await archiveWithClips();
    await pool.query(`
      create function fail_insert() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$;
      create trigger fail_archive_events before insert on archive_events for each row execute function fail_insert();`);
    const worker = startWorker({ url, archiveRoot: archive.root, reconcileIntervalMs: 300 });
    await waitFor(async () => (await state(db, "reconciliation")) === "error");
    expect((await statusRows(db)).reconciliation.last_error_message).toContain("simulated failure");
    expect(await state(db, "worker")).toBe("running");
    await pool.query("drop trigger fail_archive_events on archive_events");
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    expect((await statusRows(db)).reconciliation.details).toMatchObject({ archiveEventsCreated: 3, temporalFallbackEvents: 0 });
    await worker.stop();
  });

  it("Protect closes the stream: reconnecting, then connected again", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const protect = await FakeProtect.start();
    const worker = startWorker({ url, archiveRoot: archive.root, protect: { mode: "enabled", config: protect.config() } });
    await waitFor(async () => (await state(db, "protect")) === "connected");
    protect.rejectUpgradesWith = 502;
    protect.closeAll();
    await waitFor(async () => (await state(db, "protect")) === "reconnecting");
    expect((await statusRows(db)).protect.last_error_message).toMatch(/Event stream closed|HTTP 502/);
    protect.rejectUpgradesWith = undefined;
    await waitFor(async () => (await state(db, "protect")) === "connected");
    await worker.stop();
  });

  it("rejected API key: authenticationError, no tight re-authentication loop, key never stored", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const protect = await FakeProtect.start();
    const worker = startWorker({
      url,
      archiveRoot: archive.root,
      protect: { mode: "enabled", config: protect.config({ apiKey: "wrong-key-0000" }) },
    });
    await waitFor(async () => (await state(db, "protect")) === "authenticationError");
    const requests = protect.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(protect.requests.length).toBe(requests);
    const rows = await statusRows(db);
    expect(rows.protect.last_error_message).toContain("rejected the API key");
    expect(JSON.stringify(rows)).not.toContain("wrong-key-0000");
    expect(JSON.stringify(rows)).not.toContain(FAKE_API_KEY);
    expect(rows.worker.state).toBe("running");
    await worker.stop();
  });

  it("a second worker is refused while the first runs", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const first = startWorker({ url, archiveRoot: archive.root });
    await waitFor(async () => (await state(db, "worker")) === "running");
    const second = startWorker({ url, archiveRoot: archive.root });
    await expect(second.run).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    // The refused worker wrote nothing.
    expect(new Set(Object.values(await statusRows(db)).map((row) => row.instance_id)).size).toBe(1);
    expect(await first.stop()).toEqual({ exitCode: 0 });
  });

  it("a manual protect:collect holds the collector: the worker waits and takes over when it ends", async () => {
    const { db, url } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const protect = await FakeProtect.start();
    const releaseCli = await tryAcquireAdvisoryLock(db, LOCK_KEYS.protectCollector);
    const worker = startWorker({
      url,
      archiveRoot: archive.root,
      protect: { mode: "enabled", config: protect.config() },
      protectOverrides: { collectorBusyRetryMs: 300 },
    });
    await waitFor(async () => (await statusRows(db)).protect?.last_error_message?.includes("Another Protect collector"));
    expect(await state(db, "protect")).toBe("error");
    expect(protect.upgrades).toHaveLength(0);
    await releaseCli!();
    await waitFor(async () => (await state(db, "protect")) === "connected");
    await worker.stop();
  });

  it("fail-closed: losing the worker lock (database connection dropped) stops all work with exit code 1", async () => {
    const { db, url, pool } = await createIsolatedDb();
    const archive = await archiveWithClips();
    const worker = startWorker({ url, archiveRoot: archive.root, scanIntervalMs: 300, reconcileIntervalMs: 300 });
    await waitFor(async () => (await state(db, "reconciliation")) === "success");
    // Drop every connection of the worker – as a PostgreSQL restart would.
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'unifi-archive-worker' and datname = current_database()",
    );
    const result = await worker.run;
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/Worker exclusivity lost/);
    const scans = worker.handle!.scan.completedRuns;
    const runsInDb = (await db.execute<{ n: number }>(sql`select count(*)::int as n from archive_scan_runs`)).rows[0].n;
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Nothing runs any more.
    expect(worker.handle!.scan.completedRuns).toBe(scans);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from archive_scan_runs`)).rows[0].n).toBe(runsInDb);
    // The stale heartbeat tells the truth; a new worker can start.
    const next = startWorker({ url, archiveRoot: archive.root });
    await waitFor(async () => (await state(db, "worker")) === "running");
    await next.stop();
  });
});
