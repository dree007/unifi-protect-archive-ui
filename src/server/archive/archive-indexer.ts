import "server-only";

import { ArchiveRootError, resolveArchiveRoot } from "@/server/archive/archive-root";
import { parseClipFileName } from "@/server/archive/filename-parser";
import { discoverArchive, type DiscoveredFile } from "@/server/archive/filesystem-scanner";
import { assessMissing, DEFAULT_MISSING_GUARD, SuspiciousScanError, type MissingGuardPolicy } from "@/server/archive/missing-guard";
import { assertFileSystemType, assertMounted } from "@/server/archive/mount-check";
import type { Database } from "@/server/db/types";
import {
  markArchivedClipSeenByPath,
  upsertArchivedClips,
  type ArchivedClipInput,
  type ClipWriteOutcome,
} from "@/server/repositories/archived-clips";
import {
  completeScanRun,
  failInterruptedScanRuns,
  failScanRun,
  startScanRun,
  tryAcquireScanLock,
  type ScanRunCounts,
} from "@/server/repositories/archive-scan-runs";

/**
 * One-shot full scan of the NAS archive into `archived_clips`.
 *
 * Read-only towards the archive: the file system is only listed and `lstat`-ed (see
 * filesystem-scanner.ts); all writes go to PostgreSQL. Every clip found is stamped with the
 * run's `startedAt` as `lastSeenAt`, which makes "missing" detectable after a completed run.
 */

export interface ScanIssue {
  relativePath: string;
  message: string;
}

export interface ScanLogger {
  warning(issue: ScanIssue): void;
  failure(issue: ScanIssue): void;
  /** Only shown with --verbose: ignored entries, progress. */
  debug(message: string): void;
}

export const silentLogger: ScanLogger = { warning() {}, failure() {}, debug() {} };

interface CommonScanOptions {
  /** Raw ARCHIVE_ROOT; validated when the scan starts, never at import time. */
  archiveRoot: string | undefined;
  /** Clips per database statement (default 500). */
  batchSize?: number;
  statConcurrency?: number;
  logger?: ScanLogger;
  /** Issues kept in the result for display; counts are always exact (default 200). */
  maxReportedIssues?: number;
  /** File system discovery; replaceable in tests (e.g. to simulate a lost NAS connection). */
  discover?: typeof discoverArchive;
  /** Mount point (ARCHIVE_ROOT or a parent) that must be mounted, else the scan fails. */
  requiredMount?: string | null;
  /** File system types ARCHIVE_ROOT must lie on (ARCHIVE_REQUIRED_FS_TYPE), else the scan fails. */
  requiredFsTypes?: readonly string[] | null;
  /** Ends the scan early (worker shutdown); the run is recorded as failed. */
  signal?: AbortSignal;
}

export interface ScanOptions extends CommonScanOptions {
  db: Database;
  /**
   * Refuses to complete a run that would make an implausible number of clips missing at once
   * (NAS mount gone, empty directory left behind). `false` accepts any result (manual
   * `--accept-missing` after files were really removed).
   */
  missingGuard?: MissingGuardPolicy | false;
}

/** Progress of a scan; filled while scanning, so a failed scan still reports what it did. */
export interface ScanProgress {
  counts: ScanRunCounts;
  /** MP4 files found (indexable + failed). */
  filesFound: number;
  ignoredCount: number;
  warnings: ScanIssue[];
  failures: ScanIssue[];
}

export interface ScanResult extends ScanProgress {
  status: "completed" | "failed" | "dryRun";
  runId?: string;
  archiveRoot: string;
  startedAt: Date;
  finishedAt: Date;
  /** Clips not found by this scan; only for completed scans. */
  missingCount: number | null;
  errorMessage?: string;
}

/** Thrown when another scan holds the scan lock; no run is recorded. */
export class ScanAlreadyRunningError extends Error {
  override name = "ScanAlreadyRunningError";
  constructor() {
    super("Another archive scan is already running.");
  }
}

function newProgress(): ScanProgress {
  return {
    counts: {
      dayDirectoryCount: 0,
      discoveredCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      failedCount: 0,
      warningCount: 0,
    },
    filesFound: 0,
    ignoredCount: 0,
    warnings: [],
    failures: [],
  };
}

/** Turns a discovered file into clip data, or explains why it cannot be indexed. */
export function toClipInput(
  file: DiscoveredFile,
  seenAt: Date,
): { ok: true; input: ArchivedClipInput; warning?: string } | { ok: false; message: string } {
  const parsed = parseClipFileName(file.fileName);
  if (!parsed.ok) return { ok: false, message: `${parsed.error.code}: ${parsed.error.message}` };
  const { cameraName, startAt, endAt, durationMs, startLocalDate } = parsed.value;
  return {
    ok: true,
    input: {
      cameraName,
      startAt,
      endAt,
      durationMs,
      filePath: file.relativePath,
      fileName: file.fileName,
      fileSizeBytes: file.sizeBytes,
      fileModifiedAt: file.modifiedAt,
      dayDirectory: file.dayDirectory,
      seenAt,
    },
    // The file name is the primary source; a mismatching folder is only reported.
    warning:
      startLocalDate === file.dayDate
        ? undefined
        : `day folder ${file.dayDirectory} does not match start date ${startLocalDate} from the file name`,
  };
}

/**
 * Full scan with persistence and a recorded scan run. Fundamental problems (archive root
 * missing, directory listing or database failing) end the run as `failed`; problems with
 * single files are counted and the scan continues. Throws only if no run can be recorded
 * (database unreachable, another scan running).
 */
export async function runArchiveScan(options: ScanOptions): Promise<ScanResult> {
  const { db } = options;
  // Serialize scans: concurrent full scans would make missing detection ambiguous.
  const release = await tryAcquireScanLock(db);
  if (!release) throw new ScanAlreadyRunningError();
  try {
    // Holding the lock, any `running` run is a leftover of a process that died.
    await failInterruptedScanRuns(db);
    const run = await startScanRun(options.archiveRoot?.trim() || "(not set)", db);
    const progress = newProgress();
    let archiveRoot = options.archiveRoot ?? "";
    try {
      archiveRoot = await resolveArchiveRoot(options.archiveRoot);
      await assertArchiveMounted(archiveRoot, options);
      await scan(archiveRoot, run.startedAt, progress, options, {
        upsert: (batch) => upsertArchivedClips(batch, db),
        markSeen: (filePath, seenAt) => markArchivedClipSeenByPath(filePath, seenAt, db),
      });
      const guard = options.missingGuard ?? DEFAULT_MISSING_GUARD;
      const completed = await completeScanRun(
        run,
        progress.counts,
        db,
        guard
          ? (delta) => {
              const refusal = assessMissing({ filesFound: progress.filesFound, ...delta }, guard);
              if (refusal) throw new SuspiciousScanError(refusal);
            }
          : undefined,
      );
      return {
        ...progress,
        status: "completed",
        runId: run.id,
        archiveRoot,
        startedAt: run.startedAt,
        finishedAt: completed.finishedAt ?? new Date(),
        missingCount: completed.missingCount,
      };
    } catch (error) {
      const errorMessage = describeError(error);
      const failed = await failScanRun(run.id, progress.counts, errorMessage, db);
      return {
        ...progress,
        status: "failed",
        runId: run.id,
        archiveRoot,
        startedAt: run.startedAt,
        finishedAt: failed?.finishedAt ?? new Date(),
        missingCount: null,
        errorMessage,
      };
    }
  } finally {
    await release();
  }
}

/** Scans, parses and stats everything, but writes nothing (no database needed). */
export async function runDryArchiveScan(options: CommonScanOptions): Promise<ScanResult> {
  const startedAt = new Date();
  const archiveRoot = await resolveArchiveRoot(options.archiveRoot);
  await assertArchiveMounted(archiveRoot, options);
  const progress = newProgress();
  await scan(archiveRoot, startedAt, progress, options, undefined);
  return { ...progress, status: "dryRun", archiveRoot, startedAt, finishedAt: new Date(), missingCount: null };
}

async function assertArchiveMounted(archiveRoot: string, options: CommonScanOptions): Promise<void> {
  if (options.requiredMount) await assertMounted(options.requiredMount);
  if (options.requiredFsTypes?.length) await assertFileSystemType(archiveRoot, options.requiredFsTypes);
}

function describeError(error: unknown): string {
  if (error instanceof ArchiveRootError || error instanceof SuspiciousScanError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Interrupted: the scan was stopped (shutdown).";
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/** Database side of a scan; absent in a dry run. */
interface ClipStore {
  upsert(batch: ArchivedClipInput[]): Promise<{ outcome: ClipWriteOutcome }[]>;
  /** Keeps a known clip "seen" when only its metadata was unreadable; false if unknown. */
  markSeen(filePath: string, seenAt: Date): Promise<boolean>;
}

async function scan(
  archiveRoot: string,
  seenAt: Date,
  progress: ScanProgress,
  {
    batchSize = 500,
    statConcurrency,
    logger = silentLogger,
    maxReportedIssues = 200,
    discover = discoverArchive,
    signal,
  }: CommonScanOptions,
  store: ClipStore | undefined,
): Promise<void> {
  const { counts } = progress;
  let batch: ArchivedClipInput[] = [];

  const fail = (issue: ScanIssue) => {
    counts.failedCount++;
    if (progress.failures.length < maxReportedIssues) progress.failures.push(issue);
    logger.failure(issue);
  };
  const warn = (issue: ScanIssue) => {
    counts.warningCount++;
    if (progress.warnings.length < maxReportedIssues) progress.warnings.push(issue);
    logger.warning(issue);
  };
  const flush = async () => {
    if (batch.length === 0) return;
    if (store) {
      for (const { outcome } of await store.upsert(batch)) {
        if (outcome === "inserted") counts.discoveredCount++;
        else if (outcome === "updated") counts.updatedCount++;
        else counts.unchangedCount++;
      }
    }
    logger.debug(`${store ? "persisted" : "checked"} ${batch.length} clips (${progress.filesFound} files so far)`);
    batch = [];
  };

  for await (const item of discover(archiveRoot, { statConcurrency })) {
    signal?.throwIfAborted();
    switch (item.kind) {
      case "dayDirectory":
        counts.dayDirectoryCount++;
        logger.debug(`scanning ${item.name}/`);
        break;
      case "ignored":
        progress.ignoredCount++;
        logger.debug(`ignored ${item.relativePath} (${item.reason})`);
        break;
      case "fileError":
        if (item.presence === "vanished") {
          // Deleted while scanning: not seen, so a previously indexed clip may become missing.
          logger.debug(`vanished during scan: ${item.relativePath}`);
          break;
        }
        // Listed but unreadable: the file exists. It counts as failed, but a known clip is
        // marked as seen (nothing else changes) so it is not reported missing; an unknown
        // file is not indexed without metadata.
        progress.filesFound++;
        if (store) {
          const known = await store.markSeen(item.relativePath, seenAt);
          fail({
            relativePath: item.relativePath,
            message: `${item.message}; ${known ? "known clip kept as present" : "not indexed"}`,
          });
        } else {
          fail({ relativePath: item.relativePath, message: item.message });
        }
        break;
      case "file": {
        progress.filesFound++;
        const result = toClipInput(item.file, seenAt);
        if (!result.ok) {
          fail({ relativePath: item.file.relativePath, message: result.message });
          break;
        }
        if (result.warning) warn({ relativePath: item.file.relativePath, message: result.warning });
        batch.push(result.input);
        if (batch.length >= batchSize) await flush();
        break;
      }
    }
  }
  await flush();
}
