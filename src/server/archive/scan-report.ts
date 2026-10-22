import type { ScanResult } from "@/server/archive/archive-indexer";

const number = new Intl.NumberFormat("en-US");

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} min ${rest} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const TITLES: Record<ScanResult["status"], string> = {
  completed: "Protect Archive UI scan completed",
  failed: "Protect Archive UI scan FAILED",
  dryRun: "Protect Archive UI scan (dry run, nothing written)",
};

/** Human-readable summary of a scan, as printed by `npm run archive:scan`. */
export function formatScanResult(result: ScanResult): string {
  const { counts } = result;
  const rows: [string, string][] = [
    ["Root", result.archiveRoot],
    ["Started", result.startedAt.toISOString()],
    ["Finished", result.finishedAt.toISOString()],
    ["Duration", formatDuration(result.finishedAt.getTime() - result.startedAt.getTime())],
  ];
  if (result.runId) rows.push(["Scan run", result.runId]);

  const totals: [string, string][] = [
    ["Day directories", number.format(counts.dayDirectoryCount)],
    ["MP4 files found", number.format(result.filesFound)],
  ];
  if (result.status === "dryRun") {
    totals.push(["Indexable", number.format(result.filesFound - counts.failedCount)]);
  } else {
    totals.push(
      ["New", number.format(counts.discoveredCount)],
      ["Updated", number.format(counts.updatedCount)],
      ["Unchanged", number.format(counts.unchangedCount)],
    );
  }
  totals.push(
    ["Warnings", number.format(counts.warningCount)],
    ["Failed", number.format(counts.failedCount)],
    ["Ignored entries", number.format(result.ignoredCount)],
  );
  if (result.status === "completed") {
    totals.push(["Missing (not found)", number.format(result.missingCount ?? 0)]);
  }

  const width = Math.max(...[...rows, ...totals].map(([label]) => label.length)) + 2;
  const line = ([label, value]: [string, string]) => `${`${label}:`.padEnd(width)}${value}`;
  const lines = [TITLES[result.status], "", ...rows.map(line), "", ...totals.map(line)];

  if (result.errorMessage) {
    lines.push("", `Error: ${result.errorMessage}`);
    if (result.status === "failed") {
      lines.push("This run is not used for missing-file detection.");
    }
  }
  return lines.join("\n");
}
