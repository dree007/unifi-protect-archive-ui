# Database

Unifi Protect Archive UI stores metadata in PostgreSQL18 using Drizzle ORM and pg. Web pages read
live database data. Original footage stays on the NAS; no video binary is stored in PostgreSQL.

| Table | Purpose | Stable identity |
|---|---|---|
| cameras | Protect camera metadata and raw/normalized state | unique protect_device_id |
| archived_clips | One existing MP4 and its relative path/time/size | unique file_path |
| protect_events | Live event add/update snapshots | unique protect_event_id |
| archive_events | Logical review events, possibly several cameras | internal UUID |
| archive_event_clips | Event-to-clip membership | composite primary key |
| archive_event_protect_events | Event-to-Protect membership | composite primary key |
| archive_scan_runs | Scan status/count/error history | internal UUID |
| background_component_status | Worker/Protect/scan/reconciliation status | component primary key |

Internal IDs use PostgreSQL18 uuidv7; vendor IDs are separate fields. Timestamps are timestamptz;
filename GMT offsets determine recording instants, while APP_TIME_ZONE controls display/calendar
boundaries. Camera names can change; Protect device IDs retain identity. Unknown detection types
and raw Protect states remain text so new vendor values do not require an enum migration.

Memberships contain primary_group_id: metadata-derived groups remain primary, while temporal
joins can be re-evaluated and split. This is a logical group label, not an FK to an extant event.
Protect membership references internal protect_events.id, not the external vendor event ID.
Foreign keys and interval/path/status constraints prevent dangling memberships and invalid rows.
Camera deletion retains sources with nullable camera references; removing an event cascades its
membership links, not original footage. See [Matching](event-matching.md).

## Migrations

Schema sources are in src/server/db/schema; committed SQL/journal files are in drizzle.
Five migrations cover initial schema, scan runs, raw camera state, primary groups and worker status.
Runtime migration uses Drizzle's migrator under an advisory lock, pending SQL runs transactionally,
and an older application is rejected against a newer schema. Database downgrade is unsupported.

```bash
npm run db:check
npm run db:generate              # review every generated change; clean schema produces none
npm run db:migrate
```

For an upgrade, back up first and stop old web/worker before migration. Compose dependencies gate
new startup but cannot stop an old running application after failed migration. See
[Selfhosting backup/restore](selfhosting.md#backup-and-restore).

## Test safety

TEST_DATABASE_URL must point to a disposable PostgreSQL18 server where the test user can create
and drop databases. Vitest generates unique test databases and removes only those. E2E creates
its dedicated unifi_archive_e2e database. Neither should share the production server/user blindly.
The development Compose database uses localhost only; production PostgreSQL has no published port.
Credentials are never required at build time. Do not commit local URLs/passwords or dumps.
