# Event matching and temporal grouping

Reconciliation links existing clips and Protect events into logical archive events. It never
changes video files or invents detection classes. Run `npm run archive:reconcile` manually, with
--dry-run/--verbose when needed; the worker runs the same implementation automatically.

## Camera and metadata priority

Clip camera names resolve only to an unambiguous known camera. Protect device IDs resolve directly.
Renames retain resolved identities; duplicate/unknown names are not guessed. Only closed Protect
events participate in time matching. Same-camera clip/event intervals may overlap or have a gap
up to 5 seconds. A clip can connect several compatible events into its primary group.

Across cameras, shared detection types and an interval gap up to 3 seconds support metadata
grouping, bounded by a 30-second cluster span. Metadata-derived primary groups are preserved.
Conflicting detections must not be overridden by a timestamp heuristic.

## Temporal fallback

Different cameras may be joined when clip start differences are <=5 seconds, end differences
<=5 seconds and interval intersection-over-union is >=0.5. Intervals must be valid and metadata
must not contradict the join. The fallback needs no Protect connection: a clip whose camera is not
resolved (no Protect configured yet, or an unknown/ambiguous name) takes part under the camera name
from its file name, compared exactly after NFC normalization and trimming. When Protect resolves the
name later, the existing grouping is re-checked and kept. Whole-cluster checks prevent transitive chains of consecutive clips
from merging an unbounded time span. No group contains repeated camera identities through fallback.
Defaults are defined in src/server/matching/config.ts, not runtime environment settings.

| Example | Result |
|---|---|
| Driveway and Doorbell have close intervals, no metadata | Temporal group, archiveOnly |
| Compatible person detections on both | Metadata group, matched |
| One has person, the other lacks metadata | Temporal join; only one camera has confirmed metadata |
| Person versus vehicle | Separate events |
| Driveway and Doorbell without any Protect connection | Temporal group by file-name camera, archiveOnly |
| Consecutive segments of the same camera (or file-name camera) | No fallback join |

## Re-evaluation and persistence

Membership primary_group_id records primary provenance. Multiple primary groups in one event
indicate a temporal join. Each reconciliation rechecks such joins. New contradictory metadata or
changed clip intervals can split them; compatible metadata can supersede fallback provenance.
Existing event IDs are retained where possible through deterministic survivor/anchor rules.

Statuses describe available sources: matched means clips plus Protect events; archiveOnly means
clips only; pendingClip means Protect events without a clip yet. Temporal grouping does not promote
archiveOnly into a detection claim. UI labels distinguish metadata-derived and time-associated links.

Merge/split work units replace membership atomically. The entire normal run is not one transaction;
a subsequent idempotent run converges after interruption. Dry run uses a rollback transaction.
A dedicated advisory lock prevents concurrent reconciliation; source upserts retain stable identities.

## Limits

This is conservative timestamp grouping, not synchronized playback or proof that all cameras saw
one physical incident. Long continuous segments, clock skew, unusual exports and cameras sharing
one name may remain separate. There is no manual merge/split UI. Protect events missed while offline
are not recovered. Evaluate new archive formats separately rather than silently widening thresholds.
Unit/DB tests cover metadata conflicts, merge/split, repeated runs, rollback and a 20,000-clip corpus.
