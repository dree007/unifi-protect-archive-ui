import "server-only";

import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";
import type WebSocket from "ws";

import type { Database } from "@/server/db/types";

import { createBackoff, type BackoffOptions } from "./backoff";
import { syncProtectCameras } from "./camera-sync";
import { ProtectConfigError, type ProtectConfig } from "./config";
import { ProtectEventIngest } from "./event-ingest";
import { silentProtectLogger, type ProtectLogger } from "./logger";
import { EVENTS_PATH, openEventStream } from "./protect-websocket";
import { ProtectHttpError, type ProtectHttpClient } from "./protect-http-client";

/**
 * Long-running collector: syncs cameras, subscribes to the Protect event stream and stores
 * every event via upsert. Reconnects with exponential backoff on network problems and
 * re-syncs cameras after each reconnect. Stops on `signal` abort, on configuration errors and
 * on authentication failures (retrying cannot fix those).
 *
 * The official API has no replay: events that happen while the collector is disconnected are
 * not delivered later.
 */

export interface CollectorOptions {
  config: ProtectConfig;
  client: ProtectHttpClient;
  db: Database;
  signal: AbortSignal;
  logger?: ProtectLogger;
  backoff?: BackoffOptions;
  /** A connection that lasted this long resets the backoff (default 60 s). */
  stableAfterMs?: number;
  /** Ping interval; a connection without pong in between is considered dead (default 30 s). */
  heartbeatIntervalMs?: number;
  /** Pause reading from the socket when this many messages wait for the database (default 100). */
  maxPendingMessages?: number;
  /** Cooldown for the camera re-sync triggered by unknown devices (default 5 min). */
  resyncCooldownMs?: number;
  /** Test hook: called whenever the event stream is open. */
  onConnected?: () => void;
  /**
   * Connection state for the worker status (docs/background-worker.md): called on every change,
   * never per event. `detail` explains a `reconnecting` (the worker sanitizes it).
   */
  onStateChange?: (state: CollectorState, detail?: string) => void;
  /** Called after every successful camera sync with the number of cameras. */
  onCamerasSynced?: (count: number) => void;
}

export type CollectorState = "connecting" | "connected" | "reconnecting";

/** Errors that must not be retried. */
export function isFatalCollectorError(error: unknown): boolean {
  return error instanceof ProtectConfigError || (error instanceof ProtectHttpError && error.isAuthError);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runProtectCollector(options: CollectorOptions): Promise<void> {
  const { config, client, db, signal, logger = silentProtectLogger, stableAfterMs = 60_000 } = options;
  const backoff = createBackoff(options.backoff);

  // Fail fast if the database is not usable at all.
  await db.execute(sql`select 1`);

  const syncCameras = async () => {
    const result = await syncProtectCameras(client, db);
    options.onCamerasSynced?.(result.cameras.length);
    const { inserted, updated, unchanged } = result.counts;
    logger.info(`Cameras synced: ${result.cameras.length} (new ${inserted}, updated ${updated}, unchanged ${unchanged})`);
    for (const { reason } of result.invalid) logger.warn(`Skipped camera from Protect: ${reason}`);
    return result;
  };
  const ingest = new ProtectEventIngest({
    db,
    logger,
    resyncCameras: syncCameras,
    resyncCooldownMs: options.resyncCooldownMs,
  });

  let knownVersion: string | undefined;
  options.onStateChange?.("connecting");
  while (!signal.aborted) {
    let connectedForMs = 0;
    try {
      const meta = await client.getMetaInfo();
      if (meta.applicationVersion !== knownVersion) {
        logger.info(`Protect version: ${meta.applicationVersion}`);
        knownVersion = meta.applicationVersion;
      }
      await syncCameras();
      if (signal.aborted) break;
      logger.info("Connecting to event stream...");
      const session = await streamEvents(config, ingest, options, logger);
      connectedForMs = session.connectedForMs;
      if (signal.aborted) break;
      logger.warn(`Event stream closed (${session.reason}).`);
      options.onStateChange?.("reconnecting", `Event stream closed (${session.reason}).`);
    } catch (error) {
      if (isFatalCollectorError(error)) throw error;
      if (signal.aborted) break;
      logger.warn(`Protect not available: ${describe(error)}`);
      options.onStateChange?.("reconnecting", `Protect not available: ${describe(error)}`);
    }

    if (connectedForMs >= stableAfterMs) backoff.reset();
    const delay = backoff.next();
    logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${backoff.attempt})...`);
    await sleep(delay, undefined, { signal }).catch(() => {});
  }
  logger.info("Collector stopped.");
}

interface StreamSession {
  connectedForMs: number;
  reason: string;
}

/**
 * Runs one WebSocket session until it closes. Messages are processed strictly one after the
 * other; when too many wait for the database, reading from the socket is paused (backpressure).
 * Resolves after the connection closed and all received messages were processed. Rejects with
 * ProtectHttpError for rejected credentials.
 */
function streamEvents(
  config: ProtectConfig,
  ingest: ProtectEventIngest,
  { signal, heartbeatIntervalMs = 30_000, maxPendingMessages = 100, onConnected, onStateChange }: CollectorOptions,
  logger: ProtectLogger,
): Promise<StreamSession> {
  return new Promise((resolve, reject) => {
    const socket: WebSocket = openEventStream(config);
    let connectedAt: number | undefined;
    let rejectedStatus: number | undefined;
    let lastError: Error | undefined;
    let pending = 0;
    let paused = false;
    let chain: Promise<void> = Promise.resolve();
    let alive = true;
    let heartbeat: NodeJS.Timeout | undefined;

    const onAbort = () => {
      // Still in the handshake: nothing to say goodbye to (close() would abort it anyway).
      if (socket.readyState === socket.CONNECTING) {
        socket.terminate();
        return;
      }
      socket.close(1000, "collector shutdown");
      // Do not wait forever for a peer that does not answer the close handshake.
      setTimeout(() => socket.terminate(), 5000).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    socket.on("unexpected-response", (_request, response) => {
      // e.g. 401/403 (bad key) or 502 while Protect restarts. With this listener, ws neither
      // errors nor closes on its own; terminate() ends the handshake and emits "close".
      rejectedStatus = response.statusCode;
      response.resume();
      socket.terminate();
    });

    socket.on("open", () => {
      connectedAt = Date.now();
      logger.info("Connected.");
      onConnected?.();
      onStateChange?.("connected");
      heartbeat = setInterval(() => {
        if (!alive) {
          logger.warn("No heartbeat from Protect; dropping connection.");
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, heartbeatIntervalMs);
    });
    socket.on("pong", () => {
      alive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        logger.debug("ignored binary message");
        return;
      }
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString("utf8");
      pending++;
      if (pending >= maxPendingMessages && !paused) {
        paused = true;
        socket.pause();
      }
      chain = chain
        .then(() => ingest.handle(text))
        .then(
          () => undefined,
          (error: unknown) => logger.error(`Failed to store Protect event: ${describe(error)}`),
        )
        .finally(() => {
          pending--;
          if (paused && pending <= maxPendingMessages / 2) {
            paused = false;
            socket.resume();
          }
        });
    });

    socket.on("error", (error) => {
      lastError = error;
    });

    socket.on("close", (code, reasonBuffer) => {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", onAbort);
      const connectedForMs = connectedAt === undefined ? 0 : Date.now() - connectedAt;
      // Finish storing what was received before reporting the session as over.
      void chain.then(() => {
        if (rejectedStatus !== undefined && connectedAt === undefined) {
          const error = new ProtectHttpError(rejectedStatus, EVENTS_PATH);
          if (error.isAuthError) {
            reject(error);
            return;
          }
          resolve({ connectedForMs, reason: error.message });
          return;
        }
        const reasonText = reasonBuffer.toString("utf8");
        const reason =
          connectedAt === undefined
            ? `connection failed: ${lastError ? describe(lastError) : `code ${code}`}`
            : `code ${code}${reasonText ? `, ${reasonText}` : ""}`;
        resolve({ connectedForMs, reason });
      });
    });
  });
}
