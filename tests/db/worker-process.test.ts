import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/server/db/types";

import { clipPath, createTempArchive } from "../support/archive-fixture";
import { eventMessage, FakeProtect } from "../support/fake-protect";
import { createIsolatedDb } from "./helpers";
import { integrity, snapshot } from "./reconcile-world";

/**
 * The worker as a real process, like in a container: the production bundle under plain `node`
 * and `npm run worker:run` (npm → sh → tsx → node), real SIGTERM/SIGINT, exit codes, restart.
 * Every relevant variable is set explicitly and the bundle runs in an empty directory, so a
 * developer's .env.local (real database, real Protect) can never be picked up.
 */

const PROJECT = path.resolve(".");
let bundle: string;
let emptyDir: string;

beforeAll(async () => {
  // The real production build (npm run build:cli → dist/cli/worker-run.mjs). It is
  // self-contained (no node_modules needed); the process runs in an empty directory.
  await promisify(execFile)(process.execPath, ["scripts/build-cli.mts"], { cwd: PROJECT });
  bundle = path.join(PROJECT, "dist", "cli", "worker-run.mjs");
  emptyDir = await mkdtemp(path.join(tmpdir(), "unifi-archive-worker-"));
});
afterAll(() => rm(emptyDir, { recursive: true, force: true }));

const GARDEN = "660000000000000000000001";
const T = (minute: number, second = 0) => new Date(Date.UTC(2026, 7, 10, 9, minute, second));

interface Started {
  child: ChildProcess;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(command: string, args: string[], env: Record<string, string>, cwd: string): Started {
  const child = spawn(command, args, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "production", NODE_OPTIONS: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout!.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, output: () => text, exit };
}

async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const state = async (db: Database, component: string) =>
  (await db.execute<{ state: string }>(sql`select state from background_component_status where component = ${component}`)).rows[0]?.state;

/** Worker connections of this database still open (an orphaned worker would keep them). */
const workerConnections = async (db: Database) =>
  (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where application_name = 'unifi-archive-worker' and datname = current_database()`,
    )
  ).rows[0].n;

async function environment() {
  const { db, url } = await createIsolatedDb();
  const archive = await createTempArchive();
  await archive.addFile(clipPath("Garden", T(0), 30), { size: 500 });
  await archive.addFile(clipPath("Driveway", T(0, 1), 30), { size: 500 });
  const protect = await FakeProtect.start();
  const env = {
    DATABASE_URL: url,
    ARCHIVE_ROOT: archive.root,
    UNIFI_PROTECT_URL: protect.baseUrl,
    UNIFI_PROTECT_API_KEY: protect.config().apiKey,
    UNIFI_PROTECT_TLS_VERIFY: "true",
    PROTECT_COLLECTOR_ENABLED: "auto",
    ARCHIVE_SCAN_INTERVAL_MINUTES: "0.02",
    ARCHIVE_RECONCILE_INTERVAL_MINUTES: "0.01",
    WORKER_HEARTBEAT_INTERVAL_SECONDS: "1",
    WORKER_HEARTBEAT_STALE_SECONDS: "3",
    WORKER_RUN_ON_STARTUP: "true",
  };
  return { db, protect, env };
}

describe("worker process", { timeout: 120_000 }, () => {
  it("production bundle: full cycle, SIGTERM, restart, SIGINT – exit 0, no duplicates, nothing left behind", async () => {
    const { db, protect, env } = await environment();
    const first = start(process.execPath, ["--enable-source-maps", bundle], env, emptyDir);

    await waitFor(async () => (await state(db, "protect")) === "connected", "Protect connected");
    await waitFor(async () => (await state(db, "archiveScan")) === "success", "first scan");
    const eventId = randomUUID();
    protect.broadcast(eventMessage("finalUpdate", { id: eventId, device: GARDEN, start: T(0, 2).getTime(), end: T(0, 20).getTime() }));
    const events = await waitFor(async () => {
      const current = await snapshot(db);
      return current.length === 1 && current[0].status === "matched" ? current : undefined;
    }, "multi-camera archive event");
    expect(events[0]).toMatchObject({ clips: ["Driveway 09:00:01", "Garden 09:00:00"], protect: ["Garden person 09:00:02"] });
    // A few more cycles.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    first.child.kill("SIGTERM");
    expect(await first.exit).toEqual({ code: 0, signal: null });
    expect(first.output()).toContain("SIGTERM received, shutting down...");
    expect(first.output()).toContain("Worker stopped.");
    expect(await state(db, "worker")).toBe("stopped");
    expect(await workerConnections(db)).toBe(0);
    expect(protect.sockets.size).toBe(0);

    const second = start(process.execPath, [bundle], env, emptyDir);
    await waitFor(async () => (await state(db, "protect")) === "connected", "reconnected after restart");
    await waitFor(async () => (await state(db, "reconciliation")) === "success" && (await state(db, "archiveScan")) === "success", "jobs after restart");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    second.child.kill("SIGINT");
    expect(await second.exit).toEqual({ code: 0, signal: null });

    expect(await snapshot(db)).toEqual(events);
    expect(await integrity(db)).toEqual({ clips: 2, clip_links: 2, protect: 1, protect_links: 1, empty: 0 });
    expect(await workerConnections(db)).toBe(0);
    expect(second.output()).not.toContain(env.UNIFI_PROTECT_API_KEY);
  });

  it("exit codes: invalid configuration 2, second worker 3", async () => {
    const { db, env } = await environment();
    const invalid = start(process.execPath, [bundle], { ...env, ARCHIVE_SCAN_INTERVAL_MINUTES: "-1" }, emptyDir);
    expect((await invalid.exit).code).toBe(2);
    expect(invalid.output()).toContain("ARCHIVE_SCAN_INTERVAL_MINUTES must be a number");

    const first = start(process.execPath, [bundle], env, emptyDir);
    await waitFor(async () => (await state(db, "worker")) === "running", "first worker running");
    const second = start(process.execPath, [bundle], env, emptyDir);
    expect((await second.exit).code).toBe(3);
    expect(second.output()).toContain("Another background worker is already active");
    first.child.kill("SIGTERM");
    expect((await first.exit).code).toBe(0);
  });

  it("killed hard (SIGKILL): the lock is released by PostgreSQL, the status turns stale, a new worker takes over", async () => {
    const { db, env } = await environment();
    const first = start(process.execPath, [bundle], env, emptyDir);
    await waitFor(async () => (await state(db, "worker")) === "running", "worker running");
    first.child.kill("SIGKILL");
    await first.exit;
    // The row still says `running` – only the heartbeat age reveals the truth.
    expect(await state(db, "worker")).toBe("running");
    await waitFor(async () => (await workerConnections(db)) === 0, "connections closed by the server");
    const second = start(process.execPath, [bundle], env, emptyDir);
    await waitFor(async () => (await state(db, "worker")) === "running" && (await workerConnections(db)) > 0, "takeover");
    second.child.kill("SIGTERM");
    expect((await second.exit).code).toBe(0);
  });

  it("bounds a blocked scan shutdown below Docker's default stop deadline and recovers without duplicates", async () => {
    const { db, env } = await environment();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`lock table archived_clips in access exclusive mode`);
      locked();
      await gate;
    });
    await ready;
    const first = start(process.execPath, [bundle], { ...env, WORKER_RUN_ON_STARTUP: "true" }, emptyDir);
    try {
      await waitFor(() => first.output().includes("NAS scan started."), "scan starts");
      await waitFor(async () => Number((await db.execute<{ count: number }>(sql`select count(*)::int from pg_stat_activity where application_name = 'unifi-archive-worker' and datname = current_database() and wait_event_type = 'Lock'`)).rows[0].count) > 0, "worker SQL actually blocked");
      const started = Date.now();
      first.child.kill("SIGTERM");
      expect((await first.exit).code).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(async () => (await workerConnections(db)) === 0, "blocked worker sessions close before the external lock is released");
    } finally {
      first.child.kill("SIGKILL");
      release();
      await blocker;
    }
    await waitFor(async () => (await workerConnections(db)) === 0, "old worker sessions released");
    const second = start(process.execPath, [bundle], { ...env, WORKER_RUN_ON_STARTUP: "true" }, emptyDir);
    try {
      await waitFor(() => second.output().includes("Reconciliation completed"), "recovery reconciliation");
      const before = await snapshot(db);
      second.child.kill("SIGTERM");
      expect((await second.exit).code).toBe(0);
      const third = start(process.execPath, [bundle], { ...env, WORKER_RUN_ON_STARTUP: "true" }, emptyDir);
      try {
        await waitFor(() => third.output().includes("Reconciliation completed"), "second recovery");
        third.child.kill("SIGTERM");
        expect((await third.exit).code).toBe(0);
        expect(await snapshot(db)).toEqual(before);
        expect(await integrity(db)).toEqual({ clips: 2, clip_links: 2, protect: 0, protect_links: 0, empty: 0 });
      } finally { third.child.kill("SIGKILL"); }
    } finally { second.child.kill("SIGKILL"); }
  });

  for (const mode of ["deadline", "second signal"] as const) {
    it(`a stalled database handshake cannot prevent shutdown (${mode})`, async () => {
      const sockets = new Set<Socket>();
      let connected!: () => void;
      const accepted = new Promise<void>((resolve) => { connected = resolve; });
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        connected(); // Intentionally never reply to the synthetic PostgreSQL handshake.
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const worker = start(process.execPath, [bundle], { DATABASE_URL: `postgresql://synthetic_user@127.0.0.1:${port}/synthetic`, ARCHIVE_ROOT: emptyDir, PROTECT_COLLECTOR_ENABLED: "false" }, emptyDir);
      try {
        await accepted;
        const started = Date.now();
        worker.child.kill("SIGTERM");
        if (mode === "second signal") {
          await waitFor(() => worker.output().includes("SIGTERM received"), "first signal handled");
          worker.child.kill("SIGTERM");
        }
        expect((await worker.exit).code).toBe(1);
        expect(Date.now() - started).toBeLessThan(9_500);
        expect(worker.output()).toContain(mode === "deadline" ? "Shutdown deadline reached" : "Forced exit");
      } finally {
        worker.child.kill("SIGKILL");
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }

  it("npm run worker:run forwards SIGTERM through npm, sh and tsx: no orphaned worker", async () => {
    const { db, env } = await environment();
    // cwd is the project (npm needs package.json); every variable .env.local could provide is set.
    const npm = start("npm", ["run", "--silent", "worker:run"], { ...env, npm_config_update_notifier: "false" }, PROJECT);
    await waitFor(async () => (await state(db, "worker")) === "running", "worker via npm", 60_000);
    npm.child.kill("SIGTERM");
    const exit = await npm.exit;
    expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
    await waitFor(async () => (await state(db, "worker")) === "stopped", "worker stopped cleanly");
    await waitFor(async () => (await workerConnections(db)) === 0, "no worker connection left");
    expect(npm.output()).toContain("Worker stopped.");
  });
});
