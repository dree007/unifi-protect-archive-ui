// One-shot reconciliation: NAS clips + Protect events → archive events (docs/event-matching.md).
//
//   npm run archive:reconcile                  needs DATABASE_URL
//   npm run archive:reconcile -- --verbose     also steps, merges and unresolved camera names
//   npm run archive:reconcile -- --dry-run     compute everything, then roll back (nothing written)
//
// Exit codes: 0 completed, 1 failed, 2 invalid arguments.
import "./load-env.mts";

import { parseArgs } from "node:util";

import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import { reconcileArchive } from "@/server/matching/reconcile";

const USAGE = "Usage: npm run archive:reconcile -- [--dry-run] [--verbose]";

let args;
try {
  args = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
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

const number = new Intl.NumberFormat("en-US");
const line = (label: string, value: number | string) =>
  `${`${label}:`.padEnd(28)}${typeof value === "number" ? number.format(value) : value}`;

let db: Database | undefined;
let exitCode = 1;
try {
  db = getDb();
  const result = await reconcileArchive({
    db,
    dryRun: args["dry-run"],
    logger: {
      info: (message) => console.log(message),
      debug: (message) => {
        if (args.verbose) console.log(`  ${message}`);
      },
    },
  });
  console.log(
    [
      result.dryRun ? "Unifi Protect Archive UI reconciliation (dry run, nothing written)" : "Unifi Protect Archive UI reconciliation completed",
      "",
      line("Cameras resolved", result.clipCamerasResolved),
      line("Clips processed", result.clipsTotal),
      line("Protect events", result.protectEventsTotal),
      "",
      line("Clip/Event matches", result.clipEventMatches),
      line("Relations created", result.relationsCreated),
      "",
      // Groups = archive events (current state); links/joins = relations; merged/split = operations.
      line("Metadata groups", result.multiCameraEvents),
      line("Temporal fallback groups", result.temporalFallbackEvents),
      line("  new or changed", result.temporalFallbackEventsChanged),
      line("  unchanged", result.temporalFallbackEvents - result.temporalFallbackEventsChanged),
      line("Metadata joins", result.multiCameraJoins),
      line("Fallback candidates", result.temporalCandidates),
      line("  refused (metadata)", result.temporalRejectedByMetadata),
      line("  refused (cluster)", result.temporalRejectedByCluster),
      line("Fallback links added", result.temporalLinksAdded),
      line("Fallback links removed", result.temporalLinksRemoved),
      line("  superseded by metadata", result.temporalLinksSuperseded),
      "",
      line("Archive events created", result.archiveEventsCreated),
      line("Archive events merged", result.archiveEventsMerged),
      line("Archive events split", result.archiveEventsSplit),
      "",
      line("Archive only", result.status.archiveOnly),
      line("Pending clip", result.status.pendingClip),
      line("Matched", result.status.matched),
      "",
      line("Duration", `${(result.durationMs / 1000).toFixed(1)} s`),
    ].join("\n"),
  );
  if (result.unresolvedCameraNames.length > 0) {
    console.log(
      `\nClips without camera (no unambiguous Protect camera for): ${result.unresolvedCameraNames.slice(0, 20).join(", ")}` +
        (result.unresolvedCameraNames.length > 20 ? ", …" : ""),
    );
  }
  exitCode = 0;
} catch (error) {
  console.error(`Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await db?.$client.end().catch(() => {});
}
process.exit(exitCode);
