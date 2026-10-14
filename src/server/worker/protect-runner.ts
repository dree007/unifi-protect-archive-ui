import { setTimeout as sleep } from "node:timers/promises";

import type { ProtectDetails, ProtectState } from "@/domain/background";
import { LOCK_KEYS } from "@/server/db/advisory-lock";
import type { Database } from "@/server/db/types";
import type { BackoffOptions } from "@/server/protect/backoff";
import { ProtectConfigError, type ProtectConfig } from "@/server/protect/config";
import { runProtectCollector } from "@/server/protect/protect-collector";
import { ProtectHttpClient, ProtectHttpError } from "@/server/protect/protect-http-client";

import type { LeadershipSession } from "./leadership";
import type { WorkerLogger } from "./logger";
import { describeError, sanitizeStatusMessage } from "./sanitize";
import { DB_NOW, type StatusPatch, type StatusStore } from "./status";

/**
 * Runs the existing Protect collector inside the worker and mirrors its connection state into
 * the status table. The collector keeps its own reconnect/backoff; this loop only handles what
 * ends the collector:
 *
 * - rejected API key (401/403): `authenticationError`, retried after a long pause (default
 *   10 min) – never a tight re-authentication loop,
 * - another collector holds the collector lock (`npm run protect:collect`): retried every
 *   minute, so the worker takes over once the manual collector ends,
 * - anything else: `error`, retried after 30 s.
 *
 * Status is written on state changes only (never per event).
 */

export interface ProtectRunnerOptions {
  config: ProtectConfig;
  db: Database;
  leadership: LeadershipSession;
  status: StatusStore;
  logger: WorkerLogger;
  signal: AbortSignal;
  /** Called when a status write reveals that this instance lost its exclusivity. */
  onLeadershipLost: (error: unknown) => void;
  authRetryMs?: number;
  errorRetryMs?: number;
  collectorBusyRetryMs?: number;
  /** Passed to the collector (tests use short values). */
  backoff?: BackoffOptions;
  heartbeatIntervalMs?: number;
  httpTimeoutMs?: number;
}

export async function runProtect(options: ProtectRunnerOptions): Promise<void> {
  const {
    config,
    db,
    leadership,
    status,
    logger,
    signal,
    authRetryMs = 10 * 60_000,
    errorRetryMs = 30_000,
    collectorBusyRetryMs = 60_000,
  } = options;
  const secrets = [config.apiKey];

  // Serialized, deduplicated status writes (the collector's callbacks are synchronous).
  let last = { state: "", message: "", cameras: -1 };
  let writes = Promise.resolve();
  const write = (patch: StatusPatch) => {
    writes = writes
      .then(() => status.update("protect", patch))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "LeadershipLostError") options.onLeadershipLost(error);
        else logger.warn(`Could not store the Protect status: ${describeError(error)}`);
      });
  };
  const setState = (state: ProtectState, rawMessage?: string) => {
    const message = rawMessage ? sanitizeStatusMessage(rawMessage, { secrets }) : "";
    if (state === last.state && message === last.message) return;
    last = { ...last, state, message };
    const patch: StatusPatch = { state };
    if (state === "connected") patch.lastSucceededAt = DB_NOW;
    if (message) Object.assign(patch, { lastFailedAt: DB_NOW, lastErrorMessage: message });
    write(patch);
  };
  const setCameraCount = (count: number) => {
    if (count === last.cameras) return;
    last = { ...last, cameras: count };
    write({ details: { cameraCount: count } satisfies ProtectDetails });
  };

  while (!signal.aborted) {
    let retryInMs = 0;
    let locked = false;
    try {
      locked = await leadership.tryLock(LOCK_KEYS.protectCollector);
    } catch (error) {
      // The lock connection failed; the leadership session ends the worker.
      logger.error(`Protect collector lock: ${describeError(error)}`);
      break;
    }
    if (!locked) {
      setState("error", "Another Protect collector is running (npm run protect:collect); the worker takes over when it ends.");
      logger.warn("Another Protect collector is running; retrying later.");
      retryInMs = collectorBusyRetryMs;
    } else {
      const client = new ProtectHttpClient(config, { timeoutMs: options.httpTimeoutMs });
      try {
        await runProtectCollector({
          config,
          client,
          db,
          logger,
          signal,
          backoff: options.backoff,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          onStateChange: (state, detail) => setState(state, detail),
          onCamerasSynced: setCameraCount,
        });
      } catch (error) {
        const message = describeError(error);
        if (error instanceof ProtectHttpError && error.isAuthError) {
          setState("authenticationError", message);
          logger.error(`${message} Retrying in ${Math.round(authRetryMs / 60_000)} min.`);
          retryInMs = authRetryMs;
        } else if (error instanceof ProtectConfigError) {
          setState("error", message);
          logger.error(`Protect disabled until restart: ${message}`);
          break;
        } else {
          setState("error", message);
          logger.error(`Protect collector stopped: ${message}`);
          retryInMs = errorRetryMs;
        }
      } finally {
        client.close();
        await leadership.unlock(LOCK_KEYS.protectCollector).catch(() => {});
      }
    }
    if (retryInMs > 0) await sleep(retryInMs, undefined, { signal }).catch(() => {});
  }
  await writes;
}
