import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import { tryAcquireScanLock } from "@/server/repositories/archive-scan-runs";
import { LeadershipLostError, LeadershipSession, WorkerAlreadyRunningError } from "@/server/worker/leadership";
import { StatusStore } from "@/server/worker/status";

import { createIsolatedDb } from "./helpers";

const PROTECT_OFF = { protectState: "disabled" as const, protectDetails: { disabledReason: "switchedOff" as const }, protectError: null };

async function session(url: string, instanceId = randomUUID()) {
  const lost: LeadershipLostError[] = [];
  const leadership = await LeadershipSession.acquire({ databaseUrl: url, instanceId, onLost: (error) => lost.push(error) });
  return { leadership, lost, instanceId };
}

async function lockHolders(db: Awaited<ReturnType<typeof createIsolatedDb>>["pool"]): Promise<number[]> {
  const { rows } = await db.query<{ pid: number }>(
    `select pid from pg_locks where locktype = 'advisory' and granted and objid::bigint = ($1::bigint & 4294967295)
       and database = (select oid from pg_database where datname = current_database())`,
    [LOCK_KEYS.worker],
  );
  return rows.map((row) => row.pid);
}

describe("worker exclusivity", () => {
  it("the first worker gets the lock, a second one is refused, the lock is free after shutdown", async () => {
    const { url, pool } = await createIsolatedDb();
    const a = await session(url);
    await expect(LeadershipSession.acquire({ databaseUrl: url, instanceId: randomUUID(), onLost() {} })).rejects.toBeInstanceOf(
      WorkerAlreadyRunningError,
    );
    expect(await lockHolders(pool)).toHaveLength(1);

    await a.leadership.release();
    expect(a.lost).toEqual([]);
    expect(await lockHolders(pool)).toHaveLength(0);
    const b = await session(url);
    await b.leadership.release();
  });

  it("a killed worker process (connection gone) releases the lock; the old session notices", async () => {
    const { url, pool } = await createIsolatedDb();
    const a = await session(url);
    const [pid] = await lockHolders(pool);
    // What PostgreSQL sees when the process dies or the server drops the connection.
    await pool.query("select pg_terminate_backend($1)", [pid]);
    await expect.poll(() => a.lost.length).toBe(1);
    expect(a.lost[0].message).toMatch(/Worker exclusivity lost/);
    await expect(a.leadership.assertHeld()).rejects.toBeInstanceOf(LeadershipLostError);
    await expect(a.leadership.heartbeat()).rejects.toBeInstanceOf(LeadershipLostError);

    const b = await session(url);
    expect(await lockHolders(pool)).toHaveLength(1);
    await a.leadership.release();
    await b.leadership.release();
  });

  it("the heartbeat is written on the lock connection and ages by the database clock", async () => {
    const { db, url, pool } = await createIsolatedDb();
    const a = await session(url);
    const status = new StatusStore(db, a.instanceId);
    await status.takeOver(PROTECT_OFF);
    await pool.query("update background_component_status set heartbeat_at = now() - interval '10 minutes' where component = 'worker'");
    const at = await a.leadership.heartbeat();
    const { rows } = await pool.query<{ age: number }>(
      "select extract(epoch from now() - heartbeat_at) as age from background_component_status where component = 'worker'",
    );
    expect(Number(rows[0].age)).toBeLessThan(5);
    expect(at).toBeInstanceOf(Date);
    await a.leadership.release();
  });

  it("an old instance can neither overwrite the status of a newer one nor keep working", async () => {
    const { db, url, pool } = await createIsolatedDb();
    // Worker A runs …
    const a = await session(url);
    const statusA = new StatusStore(db, a.instanceId);
    await statusA.takeOver(PROTECT_OFF);
    await statusA.update("worker", { state: "running" });
    // … loses its database connection (and with it the lock); B takes over.
    const [pid] = await lockHolders(pool);
    await pool.query("select pg_terminate_backend($1)", [pid]);
    await expect.poll(() => a.lost.length).toBe(1);
    const b = await session(url);
    const statusB = new StatusStore(db, b.instanceId);
    await statusB.takeOver(PROTECT_OFF);
    await statusB.update("worker", { state: "running" });

    // A is reachable again (pool reconnects): every status write is rejected.
    await expect(statusA.update("worker", { state: "stopped" })).rejects.toBeInstanceOf(LeadershipLostError);
    await expect(statusA.update("archiveScan", { state: "running" })).rejects.toBeInstanceOf(LeadershipLostError);
    const { rows } = await pool.query<{ component: string; instance_id: string; state: string }>(
      "select component, instance_id, state from background_component_status order by component",
    );
    expect(rows.every((row) => row.instance_id === b.instanceId)).toBe(true);
    expect(rows.find((row) => row.component === "worker")?.state).toBe("running");

    await a.leadership.release();
    await b.leadership.release();
  });

  it("a heartbeat is refused when the worker row was taken over (no lock, no heartbeat)", async () => {
    const { db, url } = await createIsolatedDb();
    const a = await session(url);
    await new StatusStore(db, a.instanceId).takeOver(PROTECT_OFF);
    // Simulates a takeover by another instance (e.g. after a split brain).
    await new StatusStore(db, randomUUID()).takeOver(PROTECT_OFF);
    await expect(a.leadership.heartbeat()).rejects.toThrow(/heartbeat rejected/);
    expect(a.lost).toHaveLength(1);
    await a.leadership.release();
  });

  it("the takeover marks a job left running by a dead worker as interrupted, keeping its history", async () => {
    const { db, url, pool } = await createIsolatedDb();
    const a = await session(url);
    const statusA = new StatusStore(db, a.instanceId);
    await statusA.takeOver(PROTECT_OFF);
    await statusA.update("reconciliation", { state: "success", lastSucceededAt: new Date("2026-10-09T10:00:00Z") });
    await statusA.update("archiveScan", { state: "running" });
    await a.leadership.release();

    const b = await session(url);
    await new StatusStore(db, b.instanceId).takeOver(PROTECT_OFF);
    const { rows } = await pool.query<{ component: string; state: string; last_error_message: string | null; last_succeeded_at: Date | null }>(
      "select component, state, last_error_message, last_succeeded_at from background_component_status order by component",
    );
    expect(rows.find((row) => row.component === "archiveScan")).toMatchObject({ state: "error", last_error_message: expect.stringContaining("Interrupted") });
    expect(rows.find((row) => row.component === "reconciliation")).toMatchObject({
      state: "success",
      last_succeeded_at: new Date("2026-10-09T10:00:00Z"),
    });
    expect(rows.find((row) => row.component === "worker")).toMatchObject({ state: "starting" });
    await b.leadership.release();
  });

  it("job locks and the collector lock work alongside the worker lock without deadlocks", async () => {
    const { db, url } = await createIsolatedDb();
    const a = await session(url);
    // The worker's scan lock (pool connection) is independent of the worker lock.
    const releaseScan = await tryAcquireScanLock(db);
    expect(releaseScan).not.toBeNull();
    await releaseScan!();

    // Protect collector: the worker holds it on its lock session …
    expect(await a.leadership.tryLock(LOCK_KEYS.protectCollector)).toBe(true);
    // … so `npm run protect:collect` (pool connection) cannot start a second collector.
    expect(await tryAcquireAdvisoryLock(db, LOCK_KEYS.protectCollector)).toBeNull();
    await a.leadership.unlock(LOCK_KEYS.protectCollector);
    // And the other way round.
    const releaseCli = await tryAcquireAdvisoryLock(db, LOCK_KEYS.protectCollector);
    expect(releaseCli).not.toBeNull();
    expect(await a.leadership.tryLock(LOCK_KEYS.protectCollector)).toBe(false);
    await releaseCli!();
    await a.leadership.release();
  });
});
