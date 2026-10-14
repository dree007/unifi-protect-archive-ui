import "server-only";

import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";

import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import { getDb } from "@/server/db/client";
import {
  archivedClips,
  archiveScanRuns,
  type ArchivedClipRow,
  type ArchiveScanRunRow,
} from "@/server/db/schema";
import type { Database, DbExecutor } from "@/server/db/types";

export interface ScanRunCounts {
  dayDirectoryCount: number;
  discoveredCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  warningCount: number;
}

/** Takes the advisory lock that serializes archive scans; `null` if a scan is running. */
export function tryAcquireScanLock(db: Database = getDb()): Promise<(() => Promise<void>) | null> {
  return tryAcquireAdvisoryLock(db, LOCK_KEYS.archiveScan);
}

/**
 * Marks runs left in `running` as failed. Only call while holding the scan lock: then no other
 * scan is active, and such runs belong to processes that ended without finishing.
 */
export async function failInterruptedScanRuns(db: DbExecutor = getDb()): Promise<number> {
  const rows = await db
    .update(archiveScanRuns)
    .set({
      status: "failed",
      finishedAt: sql`now()`,
      errorMessage: "Interrupted: the scan process ended before the scan finished.",
    })
    .where(eq(archiveScanRuns.status, "running"))
    .returning({ id: archiveScanRuns.id });
  return rows.length;
}

/** Creates a `running` run; `startedAt` comes from the database clock. */
export async function startScanRun(archiveRoot: string, db: DbExecutor = getDb()): Promise<ArchiveScanRunRow> {
  const [run] = await db.insert(archiveScanRuns).values({ archiveRoot }).returning();
  return run;
}

/** What a run would change about "missing": the input of the missing guard. */
export interface MissingDelta {
  /** Clips present in the last completed scan (all clips if there was none). */
  previouslyPresent: number;
  /** Of these, clips the run did not find. */
  newlyMissing: number;
}

/**
 * Marks the run completed and records how many clips it did not find
 * (`last_seen_at < started_at`), in one transaction. `check` runs first, inside the same
 * transaction; if it throws, nothing is completed (see archive/missing-guard.ts).
 */
export async function completeScanRun(
  run: Pick<ArchiveScanRunRow, "id" | "startedAt">,
  counts: ScanRunCounts,
  db: Database = getDb(),
  check?: (delta: MissingDelta) => void,
): Promise<ArchiveScanRunRow> {
  return db.transaction(async (tx) => {
    if (check) check(await missingDelta(run.startedAt, tx));
    const missingCount = await countClipsNotSeenSince(run.startedAt, tx);
    const [completed] = await tx
      .update(archiveScanRuns)
      .set({ ...counts, missingCount, status: "completed", finishedAt: sql`now()` })
      .where(and(eq(archiveScanRuns.id, run.id), eq(archiveScanRuns.status, "running")))
      .returning();
    if (!completed) throw new Error(`Scan run ${run.id} is no longer running.`);
    return completed;
  });
}

export async function failScanRun(
  runId: string,
  counts: ScanRunCounts,
  errorMessage: string,
  db: DbExecutor = getDb(),
): Promise<ArchiveScanRunRow | undefined> {
  const [failed] = await db
    .update(archiveScanRuns)
    .set({ ...counts, status: "failed", finishedAt: sql`now()`, errorMessage })
    .where(and(eq(archiveScanRuns.id, runId), eq(archiveScanRuns.status, "running")))
    .returning();
  return failed;
}

export async function findScanRunById(id: string, db: DbExecutor = getDb()): Promise<ArchiveScanRunRow | undefined> {
  const [run] = await db.select().from(archiveScanRuns).where(eq(archiveScanRuns.id, id)).limit(1);
  return run;
}

/** The most recent successfully completed full scan: the only valid basis for "missing". */
export async function findLatestCompletedScanRun(db: DbExecutor = getDb()): Promise<ArchiveScanRunRow | undefined> {
  const [run] = await db
    .select()
    .from(archiveScanRuns)
    .where(eq(archiveScanRuns.status, "completed"))
    .orderBy(desc(archiveScanRuns.startedAt))
    .limit(1);
  return run;
}

export async function listScanRuns({ limit = 20 } = {}, db: DbExecutor = getDb()): Promise<ArchiveScanRunRow[]> {
  return db.select().from(archiveScanRuns).orderBy(desc(archiveScanRuns.startedAt)).limit(limit);
}

/** Compares a running scan (started at `since`) with the last completed scan. */
async function missingDelta(since: Date, db: DbExecutor): Promise<MissingDelta> {
  const basis = await findLatestCompletedScanRun(db);
  const present = basis ? gte(archivedClips.lastSeenAt, basis.startedAt) : undefined;
  const [row] = await db
    .select({
      previouslyPresent: count(),
      newlyMissing: sql<number>`(count(*) filter (where ${archivedClips.lastSeenAt} < ${since}))::int`,
    })
    .from(archivedClips)
    .where(present);
  return row;
}

async function countClipsNotSeenSince(since: Date, db: DbExecutor): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(archivedClips).where(lt(archivedClips.lastSeenAt, since));
  return value;
}

/**
 * Clips that the latest completed full scan did not find (still stored, never deleted here).
 * Empty if no scan has completed yet. Failed or running scans are ignored.
 */
export async function listMissingClips(
  { limit = 100 } = {},
  db: DbExecutor = getDb(),
): Promise<{ basis: ArchiveScanRunRow | undefined; clips: ArchivedClipRow[] }> {
  const basis = await findLatestCompletedScanRun(db);
  if (!basis) return { basis, clips: [] };
  const clips = await db
    .select()
    .from(archivedClips)
    .where(lt(archivedClips.lastSeenAt, basis.startedAt))
    .orderBy(asc(archivedClips.filePath))
    .limit(limit);
  return { basis, clips };
}
