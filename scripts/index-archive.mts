// Manual one-shot scan of the NAS archive into PostgreSQL. Read-only towards the archive.
//
//   npm run archive:scan                 full scan (needs ARCHIVE_ROOT and DATABASE_URL)
//   npm run archive:scan -- --verbose    also list ignored entries and progress
//   npm run archive:scan -- --dry-run    scan and parse only, write nothing (no database needed)
//   npm run archive:scan -- --accept-missing
//                                        complete even if very many clips would be missing at
//                                        once (only after files were really removed from the NAS)
//
// Honours ARCHIVE_REQUIRED_MOUNT and ARCHIVE_REQUIRED_FS_TYPE (both optional): the scan fails if
// the NAS is not mounted.
//
// Exit codes: 0 completed, 1 scan failed or could not start, 2 invalid arguments.
import "./load-env.mts";

import { parseArgs } from "node:util";

import {
  runArchiveScan,
  runDryArchiveScan,
  ScanAlreadyRunningError,
  type ScanIssue,
  type ScanLogger,
} from "@/server/archive/archive-indexer";
import { ArchiveRootError } from "@/server/archive/archive-root";
import { parseFileSystemTypes } from "@/server/archive/mount-check";
import { formatScanResult } from "@/server/archive/scan-report";
import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/types";

const USAGE = "Usage: npm run archive:scan -- [--dry-run] [--verbose] [--accept-missing]";
/** Issues printed while scanning; the summary always has the exact counts. */
const MAX_PRINTED_ISSUES = 200;

let args;
try {
  args = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "accept-missing": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

let printed = 0;
const printIssue = (kind: string, issue: ScanIssue) => {
  printed++;
  if (printed <= MAX_PRINTED_ISSUES) console.error(`${kind} ${issue.relativePath}: ${issue.message}`);
  else if (printed === MAX_PRINTED_ISSUES + 1) console.error("… further warnings/failures are not printed");
};
const logger: ScanLogger = {
  warning: (issue) => printIssue("WARN", issue),
  failure: (issue) => printIssue("FAIL", issue),
  debug: (message) => {
    if (args.verbose) console.log(`  ${message}`);
  },
};

const archiveRoot = process.env.ARCHIVE_ROOT;
const requiredMount = process.env.ARCHIVE_REQUIRED_MOUNT?.trim() || null;
let requiredFsTypes: string[] | null;
try {
  requiredFsTypes = parseFileSystemTypes(process.env.ARCHIVE_REQUIRED_FS_TYPE);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
let db: Database | undefined;
let exitCode = 1;
try {
  const result = args["dry-run"]
    ? await runDryArchiveScan({ archiveRoot, requiredMount, requiredFsTypes, logger })
    : await runArchiveScan({
        archiveRoot,
        requiredMount,
        requiredFsTypes,
        logger,
        db: (db = getDb()),
        missingGuard: args["accept-missing"] ? false : undefined,
      });
  if (printed > 0) console.log("");
  console.log(formatScanResult(result));
  exitCode = result.status === "failed" ? 1 : 0;
} catch (error) {
  if (error instanceof ArchiveRootError || error instanceof ScanAlreadyRunningError) {
    console.error(`Scan not started: ${error.message}`);
  } else {
    console.error("Scan not started:", error);
  }
} finally {
  await db?.$client.end().catch(() => {});
}
process.exit(exitCode);
