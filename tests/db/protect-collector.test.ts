import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { cameras, protectEvents } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import type { ProtectConfig } from "@/server/protect/config";
import type { ProtectLogger } from "@/server/protect/logger";
import { runProtectCollector, type CollectorOptions } from "@/server/protect/protect-collector";
import { ProtectHttpClient, ProtectHttpError } from "@/server/protect/protect-http-client";

import { eventMessage, FAKE_API_KEY, FakeProtect, SYNTHETIC_EVENT } from "../support/fake-protect";
import { createIsolatedDb } from "./helpers";

async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function recordingLogger() {
  const lines: string[] = [];
  const logger: ProtectLogger = {
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
    debug: (m) => lines.push(`DEBUG ${m}`),
  };
  return { logger, lines };
}

/** Starts a collector against `protect`; stop it with `stop()` (graceful shutdown). */
async function startCollector(protect: FakeProtect, overrides: Partial<CollectorOptions> & { config?: ProtectConfig; db?: Database } = {}) {
  const db = overrides.db ?? (await createIsolatedDb()).db;
  const config = overrides.config ?? protect.config();
  const client = new ProtectHttpClient(config, { timeoutMs: 2000 });
  const controller = new AbortController();
  const { logger, lines } = recordingLogger();
  const run = runProtectCollector({
    config,
    client,
    db,
    logger,
    signal: controller.signal,
    backoff: { initialMs: 20, maxMs: 100, jitterRatio: 0 },
    heartbeatIntervalMs: 1000,
    ...overrides,
  }).finally(() => client.close());
  const stop = async () => {
    controller.abort();
    await run;
  };
  return { db, run, stop, lines };
}

const eventRow = (db: Database, id: string) =>
  db.select().from(protectEvents).where(eq(protectEvents.protectEventId, id)).then(([row]) => row);

describe("Protect collector", () => {
  it("syncs cameras, connects with the API key and stores live events", async () => {
    const protect = await FakeProtect.start();
    const connection = protect.nextConnection();
    const { db, stop, lines } = await startCollector(protect);
    try {
      await connection;
      expect(protect.upgrades.at(-1)).toEqual({ apiKey: FAKE_API_KEY });
      expect(await db.select().from(cameras)).toHaveLength(6);

      protect.broadcast(SYNTHETIC_EVENT.add);
      protect.broadcast(SYNTHETIC_EVENT.update);
      protect.broadcast(SYNTHETIC_EVENT.finalUpdate);

      const row = await waitFor(async () => {
        const found = await eventRow(db, SYNTHETIC_EVENT.add.item.id);
        return found?.endAt ? found : undefined;
      });
      const [garden] = await db.select().from(cameras).where(eq(cameras.name, "Garden"));
      expect(row).toMatchObject({ cameraId: garden.id, endAt: new Date(1768471212610), smartDetectTypes: ["person"] });
      expect(await db.select().from(protectEvents)).toHaveLength(1);
      expect(lines).toContain("INFO Protect version: 7.1.87");
      expect(lines).toContain("INFO Connected.");
      expect(lines.join("\n")).not.toContain(FAKE_API_KEY);
    } finally {
      await stop();
    }
  });

  it("survives invalid JSON and irrelevant messages", async () => {
    const protect = await FakeProtect.start();
    const connection = protect.nextConnection();
    const { db, stop, lines } = await startCollector(protect);
    try {
      await connection;
      protect.broadcast("{not json");
      protect.broadcast({ type: "add", item: { id: "x", modelKey: "camera" } });
      protect.broadcast({ hello: "world" });
      protect.broadcast(eventMessage("add", { id: "after-garbage" }));

      await waitFor(() => eventRow(db, "after-garbage"));
      expect(lines).toContain("WARN Skipped Protect message: not valid JSON");
    } finally {
      await stop();
    }
  });

  it("reconnects after the server closes the stream and re-syncs cameras", async () => {
    const protect = await FakeProtect.start();
    const first = protect.nextConnection();
    const { db, stop, lines } = await startCollector(protect);
    try {
      await first;
      const cameraRequests = () => protect.requests.filter((r) => r.path === "/cameras").length;
      expect(cameraRequests()).toBe(1);

      // Protect restarts; meanwhile a camera gets renamed.
      protect.routes["/cameras"].body = (protect.routes["/cameras"].body as Record<string, unknown>[]).map((camera) =>
        camera.name === "Driveway" ? { ...camera, name: "Driveway vorne" } : camera,
      );
      const second = protect.nextConnection();
      protect.closeAll(1012, "service restart");
      await second;

      expect(cameraRequests()).toBe(2);
      expect((await db.select().from(cameras).where(eq(cameras.name, "Driveway vorne"))).length).toBe(1);
      expect(lines.some((line) => line.startsWith("WARN Event stream closed (code 1012, service restart)"))).toBe(true);
      expect(lines.some((line) => line.startsWith("INFO Reconnecting in"))).toBe(true);

      protect.broadcast(eventMessage("add", { id: "after-reconnect" }));
      await waitFor(() => eventRow(db, "after-reconnect"));
    } finally {
      await stop();
    }
  });

  it("keeps retrying while Protect is unavailable and connects once it is back", async () => {
    const protect = await FakeProtect.start();
    protect.routes["/meta/info"] = { status: 502, raw: "bad gateway" };
    const connection = protect.nextConnection();
    const { stop, lines } = await startCollector(protect);
    try {
      await waitFor(() => protect.requests.filter((r) => r.path === "/meta/info").length >= 3);
      expect(lines.some((line) => line.includes("Protect not available: Protect responded with HTTP 502"))).toBe(true);
      protect.routes["/meta/info"] = { body: { applicationVersion: "7.1.87" } };
      await connection;
    } finally {
      await stop();
    }
  });

  it("reconnects when the WebSocket upgrade fails temporarily (502)", async () => {
    const protect = await FakeProtect.start();
    protect.rejectUpgradesWith = 502;
    const { stop } = await startCollector(protect);
    try {
      await waitFor(() => protect.upgrades.length >= 2);
      const connection = protect.nextConnection();
      protect.rejectUpgradesWith = undefined;
      await connection;
    } finally {
      await stop();
    }
  });

  it("stops without retrying when the API key is rejected at start", async () => {
    const protect = await FakeProtect.start();
    const { run } = await startCollector(protect, { config: protect.config({ apiKey: "wrong-key" }) });
    await expect(run).rejects.toBeInstanceOf(ProtectHttpError);
    await expect(run).rejects.toMatchObject({ status: 401 });
    expect(protect.requests).toHaveLength(1);
    expect(protect.upgrades).toHaveLength(0);
  });

  it("stops when the event stream rejects the API key", async () => {
    const protect = await FakeProtect.start();
    protect.rejectUpgradesWith = 403;
    const { run } = await startCollector(protect);
    await expect(run).rejects.toMatchObject({ name: "ProtectHttpError", status: 403 });
    expect(protect.upgrades).toHaveLength(1);
  });

  it("shuts down gracefully while connected and while waiting to reconnect", async () => {
    const protect = await FakeProtect.start();
    const connection = protect.nextConnection();
    const connected = await startCollector(protect);
    const socket = await connection;
    await waitFor(() => connected.lines.includes("INFO Connected."));
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await connected.stop();
    expect(await closed).toBe(1000);
    expect(connected.lines.at(-1)).toBe("INFO Collector stopped.");

    // Unreachable Protect with a long backoff: abort must not wait for the delay.
    protect.routes["/meta/info"] = { status: 500 };
    const waiting = await startCollector(protect, { backoff: { initialMs: 60_000, maxMs: 60_000, jitterRatio: 0 } });
    await waitFor(() => waiting.lines.some((line) => line.startsWith("INFO Reconnecting in 60.0 s")));
    const started = Date.now();
    await waiting.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    // No further attempts after shutdown.
    const attempts = protect.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(protect.requests.length).toBe(attempts);
  });

  it("uses WSS with per-connection TLS settings", async () => {
    const protect = await FakeProtect.start({ secure: true });

    // Self-signed certificate and verification on: never connects, keeps retrying (no crash).
    const verifying = await startCollector(protect, { config: protect.config({ tlsVerify: true }) });
    await waitFor(() => verifying.lines.filter((line) => line.startsWith("INFO Reconnecting")).length >= 2);
    expect(protect.upgrades).toHaveLength(0);
    expect(verifying.lines.some((line) => /certificate/i.test(line))).toBe(true);
    await verifying.stop();

    // Verification off for this client: connects via wss://.
    const connection = protect.nextConnection();
    const insecure = await startCollector(protect, { config: protect.config({ tlsVerify: false }) });
    try {
      await connection;
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    } finally {
      await insecure.stop();
    }
  });
});
