# Background worker

Unifi Protect Archive UI uses one application image for web and worker roles. The worker scans the
read-only archive, synchronizes optional Protect cameras/events, reconciles metadata and persists
health status. It opens no ports and requires no Redis, cron or external queue.

```bash
npm run worker:run                 # development
npm run build:cli
npm run worker:start               # production bundle
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| DATABASE_URL | required | PostgreSQL; Compose also supplies PGUSER/PGDATABASE/PGPASSWORD |
| ARCHIVE_ROOT | required | Absolute read-only archive path |
| ARCHIVE_SCAN_INTERVAL_MINUTES | 15 | Pause after a full scan |
| ARCHIVE_RECONCILE_INTERVAL_MINUTES | 5 | Periodic reconciliation, also requested after scan |
| WORKER_HEARTBEAT_INTERVAL_SECONDS | 30 | Persisted heartbeat interval |
| WORKER_HEARTBEAT_STALE_SECONDS | 90 | Stale threshold, at least twice the heartbeat interval |
| WORKER_RUN_ON_STARTUP | true | Initial scan/reconciliation |
| PROTECT_COLLECTOR_ENABLED | auto | false / true / auto |
| ARCHIVE_REQUIRED_FS_TYPE | empty | Network-share type safeguard in production |
| ARCHIVE_REQUIRED_MOUNT | empty | Local CLI mount-point safeguard |

Positive decimal intervals are accepted; invalid configuration fails early. Protect false disables
collection, true requires valid configuration, and auto enables it when complete. Incomplete auto
configuration is reported without preventing NAS work. NAS-only multi-camera grouping still needs
camera identities from a previous sync; otherwise each unknown-camera clip remains separate.

## Execution and failures

Scheduling waits after job completion and prevents same-job overlap. Reconciliation is requested
after scanning; bursts coalesce. A scan error does not stop ongoing Protect/reconciliation work.
The missing guard rejects empty/implausibly reduced archives before advancing the successful scan
watermark. Original media remain read-only; see [Indexer](nas-indexer.md).

A dedicated PostgreSQL session holds the worker advisory lock. Failed heartbeat, session end/error
or lost ownership stops work fail-closed; Docker restarts an exited worker when the DB returns.
Scan/collector/reconciliation locks also coordinate manual maintenance commands. Another worker
is refused rather than processing in parallel. Reconciliation work units are atomic/idempotent.

Protect reconnects with backoff; authentication rejection has a longer retry interval, not a tight
loop. Disabled or unreachable Protect alone does not make the NAS worker unhealthy. Status is stored
in background_component_status, not inferred from container uptime or a collector boolean.

## Status and shutdown

Worker states include starting/running/stopping/stopped/error and derived stale. Protect states
include disabled/connecting/connected/reconnecting/authenticationError/error/stopped. Scan and
reconciliation states describe their last run. Rows from an old instance are not shown as current;
error text is sanitized before persistence/display. A heartbeat can be live while a component failed.

SIGTERM/SIGINT stop scheduling, close Protect, abort/finish work within the configured shutdown
budget and release connections/locks. The production CLI allows six seconds for running work
and forces a nonzero exit by eight seconds if cleanup blocks; Docker's default stop timeout is used.
No init wrapper is required: Node runs as PID 1. Incomplete atomic/idempotent work is retried. Exit codes: 0 signal
shutdown, 1 fatal DB/leadership error, 2 invalid configuration, 3 another worker already active.
A hard kill releases session locks on disconnect; stale status remains until a new instance takes over.

Docker health checks read persisted heartbeat/state. Unhealthy status alone does not restart a
container; unless-stopped restarts an exited process. See [Selfhosting](selfhosting.md) for health,
logs, recovery, migrations and the maintenance CLI bundles.

Shutdown also cancels only the current worker's tracked PostgreSQL sessions (including heartbeat)
through a short-lived bounded connection, so a blocked server query does not keep an advisory lock
after the client exits. If the database/handshake is unreachable, the eight-second CLI watchdog
still bounds process exit; retries/recovery remain necessary. No unrelated database session is canceled.
