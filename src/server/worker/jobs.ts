import type { JobState, ReconciliationDetails } from "@/domain/background";
import { runArchiveScan, ScanAlreadyRunningError, type ScanOptions } from "@/server/archive/archive-indexer";
import { formatDuration } from "@/server/archive/scan-report";
import type { Database } from "@/server/db/types";
import type { MatchingConfig } from "@/server/matching/config";
import { reconcileArchive, ReconciliationAlreadyRunningError, type ReconcileResult } from "@/server/matching/reconcile";

import type { WorkerConfig } from "./config";
import type { LeadershipSession } from "./leadership";
import { describeError, sanitizeStatusMessage } from "./sanitize";
import { DB_NOW, type StatusStore } from "./status";
import type { WorkerLogger } from "./logger";

/**
 * Bodies of the two periodic jobs. They call the existing services – the NAS indexer and the
 * reconciliation – exactly like the CLI commands do; nothing of their logic is duplicated.
 * Errors are recorded in the status and never escape (one failed run must not stop the worker),
 * except a lost worker lock, which ends the worker.
 */

export interface JobContext {
  config: WorkerConfig;
  db: Database;
  leadership: LeadershipSession;
  status: StatusStore;
  logger: WorkerLogger;
  /** Test hooks for the indexer (e.g. a failing file system). */
  scanOverrides?: Partial<Pick<ScanOptions, "discover" | "batchSize" | "missingGuard">>;
  matchingConfig?: Partial<MatchingConfig>;
}

const number = new Intl.NumberFormat("en-US");

export function reconciliationDetails(result: ReconcileResult): ReconciliationDetails {
  return {
    durationMs: result.durationMs,
    clipsTotal: result.clipsTotal,
    protectEventsTotal: result.protectEventsTotal,
    clipEventMatches: result.clipEventMatches,
    archiveEventsCreated: result.archiveEventsCreated,
    archiveEventsMerged: result.archiveEventsMerged,
    archiveEventsSplit: result.archiveEventsSplit,
    multiCameraEvents: result.multiCameraEvents,
    temporalFallbackEvents: result.temporalFallbackEvents,
  };
}

/** Last persisted state per job, restored when a run is skipped (a manual run holds the job lock). */
export type JobStates = Record<"archiveScan" | "reconciliation", JobState>;

export function createScanJob(context: JobContext, states: JobStates, afterRun: () => void) {
  const { config, db, leadership, status, logger } = context;
  const sanitize = (message: string) => sanitizeStatusMessage(message, { archiveRoot: config.archiveRoot });

  return async (signal: AbortSignal): Promise<void> => {
    await leadership.assertHeld();
    await status.update("archiveScan", { state: "running", lastStartedAt: DB_NOW, nextRunAt: null });
    logger.info("NAS scan started.");
    let next: JobState = "error";
    try {
      const result = await runArchiveScan({
        archiveRoot: config.archiveRoot,
        requiredMount: config.archiveRequiredMount,
        requiredFsTypes: config.archiveRequiredFsTypes,
        db,
        signal,
        ...context.scanOverrides,
      });
      const duration = formatDuration(result.finishedAt.getTime() - result.startedAt.getTime());
      const { counts } = result;
      if (result.status === "completed") {
        next = "success";
        await status.update("archiveScan", { state: next, lastSucceededAt: DB_NOW });
        logger.info(
          `NAS scan completed in ${duration}: ${number.format(result.filesFound)} files, ${number.format(counts.discoveredCount)} new, ` +
            `${number.format(counts.updatedCount)} updated, ${number.format(counts.failedCount)} failed, ` +
            `${number.format(result.missingCount ?? 0)} missing.`,
        );
      } else {
        const message = sanitize(result.errorMessage ?? "Scan failed.");
        await status.update("archiveScan", { state: next, lastFailedAt: DB_NOW, lastErrorMessage: message });
        logger.error(`NAS scan failed after ${duration}: ${message}`);
      }
    } catch (error) {
      if (error instanceof ScanAlreadyRunningError) {
        next = states.archiveScan;
        await status.update("archiveScan", { state: next });
        logger.warn("NAS scan skipped: another scan is running (e.g. npm run archive:scan).");
      } else {
        // No run could be recorded at all, e.g. the database is unreachable.
        const message = sanitize(describeError(error));
        await status.update("archiveScan", { state: next, lastFailedAt: DB_NOW, lastErrorMessage: message }).catch(() => {});
        logger.error(`NAS scan could not run: ${message}`);
        if (isLeadershipError(error)) throw error;
      }
    } finally {
      states.archiveScan = next;
      if (!signal.aborted) afterRun();
    }
  };
}

export function createReconcileJob(context: JobContext, states: JobStates) {
  const { db, leadership, status, logger, config } = context;

  return async (): Promise<void> => {
    await leadership.assertHeld();
    await status.update("reconciliation", { state: "running", lastStartedAt: DB_NOW, nextRunAt: null });
    let next: JobState = "error";
    try {
      // Atomic work units and idempotency also protect a run interrupted by shutdown
      // cancellation; a later worker can safely repeat incomplete work.
      const result = await reconcileArchive({ db, config: context.matchingConfig, logger: { info: logger.debug, debug() {} } });
      next = "success";
      await status.update("reconciliation", {
        state: next,
        lastSucceededAt: DB_NOW,
        details: reconciliationDetails(result) as unknown as Record<string, unknown>,
      });
      logger.info(
        `Reconciliation completed in ${formatDuration(result.durationMs)}: ${number.format(result.clipsTotal)} clips, ` +
          `${number.format(result.archiveEventsCreated)} events created, ${number.format(result.archiveEventsMerged)} merged, ` +
          `${number.format(result.archiveEventsSplit)} split, ${number.format(result.temporalFallbackEvents)} temporal fallback groups.`,
      );
    } catch (error) {
      if (error instanceof ReconciliationAlreadyRunningError) {
        next = states.reconciliation;
        await status.update("reconciliation", { state: next });
        logger.warn("Reconciliation skipped: another one is running (e.g. npm run archive:reconcile).");
        return;
      }
      if (isLeadershipError(error)) throw error;
      const message = sanitizeStatusMessage(describeError(error), { archiveRoot: config.archiveRoot });
      await status.update("reconciliation", { state: next, lastFailedAt: DB_NOW, lastErrorMessage: message }).catch(() => {});
      logger.error(`Reconciliation failed: ${message}`);
    } finally {
      states.reconciliation = next;
    }
  };
}

function isLeadershipError(error: unknown): boolean {
  return error instanceof Error && error.name === "LeadershipLostError";
}
