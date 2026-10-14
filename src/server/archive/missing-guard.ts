/**
 * Guard against a vanished NAS mount (docs/nas-indexer.md): if the NAS is unmounted, ARCHIVE_ROOT
 * may still exist – as an empty directory. A completed scan of it would make every clip
 * "missing". Before a scan run is completed, its result is compared with the last completed
 * scan; an implausible drop fails the run instead, so it is never used for missing detection.
 */

export interface MissingGuardPolicy {
  /** Refuse if more than this share of the previously present clips would be missing at once. */
  maxMissingRatio: number;
  /** … but only from this many newly missing clips on (small archives change by single clips). */
  minMissingCount: number;
}

export const DEFAULT_MISSING_GUARD: MissingGuardPolicy = { maxMissingRatio: 0.5, minMissingCount: 50 };

export interface MissingStats {
  /** MP4 files found by this scan (indexable or not). */
  filesFound: number;
  /** Clips present in the last completed scan (all clips if there was none). */
  previouslyPresent: number;
  /** Of these, clips this scan did not find. */
  newlyMissing: number;
}

/** Thrown inside the completion transaction: the run fails, nothing becomes missing. */
export class SuspiciousScanError extends Error {
  override name = "SuspiciousScanError";
}

const number = new Intl.NumberFormat("en-US");

/** Explains why the result is implausible, or returns `null` if it may be completed. */
export function assessMissing(stats: MissingStats, policy: MissingGuardPolicy = DEFAULT_MISSING_GUARD): string | null {
  const { filesFound, previouslyPresent, newlyMissing } = stats;
  if (filesFound === 0 && previouslyPresent > 0) {
    return (
      `Scan refused: no MP4 files found, but ${number.format(previouslyPresent)} clips were present before. ` +
      "Is the NAS mounted? Nothing was marked missing."
    );
  }
  if (newlyMissing >= policy.minMissingCount && newlyMissing > previouslyPresent * policy.maxMissingRatio) {
    const percent = Math.round((newlyMissing / previouslyPresent) * 100);
    return (
      `Scan refused: ${number.format(newlyMissing)} of ${number.format(previouslyPresent)} clips (${percent} %) would be ` +
      `missing at once (limit ${Math.round(policy.maxMissingRatio * 100)} %). Is the NAS completely mounted? Nothing was ` +
      "marked missing. If the files were really removed: npm run archive:scan -- --accept-missing"
    );
  }
  return null;
}
