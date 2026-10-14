# Selfhosting Unifi Protect Archive UI

Unifi Protect Archive UI runs as three permanent services: **web**, **worker** and **PostgreSQL 18**.
A fourth service, **migrate**, applies pending schema migrations and exits. Web, worker and
migrate use the same application image. No Redis, external scheduler or separate backend is needed.
No mobile app is included.

## Requirements and quick start

The supported host-security baseline is **Docker Engine >= 28.0.0** and **Compose plugin >=5.6.0**.
Engine 26 can run the functional suite; that does not pass the separate host-security gate.
These are different version numbers. Compose 5.6.0 is the tested supported baseline, not a claim
that earlier plugins lack every required feature. The distribution uses conditional
`depends_on` (healthy/successfully completed), read-only long bind mounts with
`create_host_path: false` and propagation; the acceptance suite additionally needs
`config --format json`, `up --wait` and `--wait-timeout`. Legacy `docker-compose` v1 is unsupported.
Your UniFi Protect MP4 export archive must
already be mounted and readable on the host. Node.js, npm, PostgreSQL and ffmpeg are included
in the containers and do not need to be installed on the host.

```bash
# Check the SERVER Engine version, not just the Docker client version.
docker version --format '{{.Server.Version}}'
docker compose version
curl -fsSLO https://raw.githubusercontent.com/dree007/unifi-protect-archive-ui/v1.0.0/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/dree007/unifi-protect-archive-ui/v1.0.0/.env.example
chmod 600 .env
# Edit .env: set POSTGRES_PASSWORD and NAS_ARCHIVE_HOST_PATH.
docker compose up -d
docker compose ps -a
```

Open **http://<docker-host-ip>:3100** from a permitted LAN device. No extra bind setting,
SSH tunnel, proxy, DNS entry or router forwarding is required in the default LAN mode.
Protect is optional: leave its settings empty for NAS-only use.
The first startup pulls the ready-made image, creates the schema and starts indexing; no demo data is inserted.
The default image is `ghcr.io/dree007/unifi-protect-archive-ui:1.0.0`, Linux amd64. It is pulled
anonymously; no registry account, source tree or local compilation is needed.
`migrate` exiting with code **0** is normal.

Docker Engines before 28.0.0 can allow hosts in the same Layer-2 network segment to reach
localhost-published ports. Do not rely on loopback publication with an older Engine.
See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).
Version checks cannot prove firewall/direct-routing safety; verify the actual external boundary
using the [security checklist](security.md). No separate preflight script is needed: the version
commands above and `docker compose config -q` validate the installation without duplicating
Compose environment parsing or printing interpolated credentials.

**Access protection is required for untrusted/public access.** The app has no complete user
login system and contains private footage. The default opens all IPv4 host interfaces;
firewall, VLAN and routing rules determine the actual audience. Plain HTTP is unencrypted.
Do not forward this port from your router or expose it directly to the public Internet.

## Direct LAN access

Default settings are `UNIFI_ARCHIVE_BIND_IP=0.0.0.0` and `UNIFI_ARCHIVE_PORT=3100`.
Open `http://<docker-host-ip>:3100`. Find the server's LAN IP in its network settings or with
`hostname -I`; select the address reachable from your device. Compose creates its networks and
publishes the web port automatically. No manual network/forwarding commands are needed.

Optional alternatives:

```dotenv
UNIFI_ARCHIVE_PORT=3200              # http://<docker-host-ip>:3200
UNIFI_ARCHIVE_BIND_IP=127.0.0.1       # local protected-proxy backend
# UNIFI_ARCHIVE_BIND_IP=192.0.2.10    # documentation-only example: a specific host IPv4 address
```

`0.0.0.0` means all IPv4 host interfaces, **not** guaranteed LAN-only access. It creates no login
or encryption. Every client reaching the listener can read private recordings and APIs. Use a
trusted, restricted LAN/VPN boundary and firewall/VLAN controls for the intended clients. Do not
configure router port forwarding. For untrusted/external access use authentication and HTTPS,
preferably with loopback backend binding as described in the optional proxy section.
PostgreSQL, worker and migrate still publish no ports; NAS originals remain read-only.

## Configuration

[.env.example](../.env.example) is the configuration reference. Docker Compose reads `.env`;
local development CLI commands use `.env.local`. Do not copy real secrets into images or Git.
Empty optional values use the defaults below.

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD` | required | Set a strong password before the first start |
| `NAS_ARCHIVE_HOST_PATH` | required | Existing archive directory on this host |
| `POSTGRES_DB`, `POSTGRES_USER` | `unifi_archive` | Database and user; set before the first start |
| `UNIFI_ARCHIVE_BIND_IP` | `0.0.0.0` | All IPv4 host interfaces; optionally loopback or a specific host IPv4 address |
| `UNIFI_ARCHIVE_PORT` | `3100` | Published web port on the configured host IP |
| `APP_TIME_ZONE` | `Europe/Berlin` | Display and calendar boundaries (IANA name) |
| `APP_SOURCE_URL` | empty override | Optional exact-source URL override; an approved image can supply its built-in matching source location |
| `PROTECT_COLLECTOR_ENABLED` | `auto` | `false`: off; `true`: require settings; `auto`: use if configured |
| `UNIFI_PROTECT_URL`, `UNIFI_PROTECT_API_KEY` | empty | Optional Protect console URL and Integration API key |
| `UNIFI_PROTECT_TLS_VERIFY` | `true` | `false` accepts Protect's self-signed certificate only |
| `ARCHIVE_SCAN_INTERVAL_MINUTES` | `15` | Pause after each full NAS scan |
| `ARCHIVE_RECONCILE_INTERVAL_MINUTES` | `5` | Pause after reconciliation; also runs after scans |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | `30` | Worker heartbeat |
| `WORKER_HEARTBEAT_STALE_SECONDS` | `90` | Health threshold; at least twice the heartbeat interval |
| `WORKER_RUN_ON_STARTUP` | `true` | Scan and reconcile immediately |
| `ARCHIVE_REQUIRED_FS_TYPE` | empty | Optional allowed filesystem types, e.g. `nfs4,cifs` |
| `NAS_ARCHIVE_GID` | `1000` | Extra numeric group for archive read access |
| `NAS_ARCHIVE_PROPAGATION` | `rprivate` | Optional `rslave` with a shared/slave host source |
| `THUMBNAIL_MAX_CONCURRENCY` | `2` | Maximum simultaneous thumbnail ffmpeg processes |

Inside the distribution, `ARCHIVE_ROOT=/archive` and `THUMBNAIL_CACHE_ROOT=/data/thumbnails` are
fixed to match the mounts. Do not add competing values to `.env`. `DATABASE_URL` contains only
the internal host/port; `PGUSER`, `PGDATABASE` and `PGPASSWORD` carry the credentials separately,
so special characters are never concatenated into a URL. No database credentials are sent to
browser components. Values containing `$`, `#` or spaces should be single-quoted in `.env`, e.g.
`POSTGRES_PASSWORD='a$b#c'`. To include a single quote, escape it as `\'` within the quoted value.
A generated hexadecimal password avoids quoting concerns (`openssl rand -hex 24`).

Changing `POSTGRES_PASSWORD` on an existing database does not change the stored role password:
change the role password through an authorized database maintenance session, then update `.env`
and recreate the app containers. Keep the database name/user unchanged after initial installation.
Docker administrators can see runtime environment values via inspect/config; protect Docker access.

## Services, image and persistence

| Service | Role | Persistence / networking |
|---|---|---|
| `postgres` | PostgreSQL 18 | `postgres-data`, internal network, no host port |
| `migrate` | One-shot Drizzle runtime migrator | Same app image; no NAS mount, no port |
| `web` | Next.js standalone server, video ranges, on-demand thumbnails | Archive read-only; thumbnail volume; configured host port |
| `worker` | NAS indexing, reconciliation, optional Protect/WebSocket, heartbeats | Archive read-only; status in PostgreSQL; no ports |

The multi-stage Dockerfile uses a pinned Node 24 Debian Slim base, `npm ci`, Next.js
`output: standalone` and bundled Node CLI entrypoints. The runtime includes static/public assets,
SQL migrations and their journal, and Debian ffmpeg. It has no tsx, esbuild or drizzle-kit runtime
requirement. Original videos are streamed unchanged; ffmpeg generates thumbnails, with no
transcoding of the archive. Debian package repositories still supply security updates during
rebuilds; the Node base digest is explicitly updated when adopting a newer Node patch release.

| Data | Container location | Backup |
|---|---|---|
| PostgreSQL metadata | `postgres-data` at `/var/lib/postgresql`; PostgreSQL 18 uses `/var/lib/postgresql/18/docker` | Required |
| Thumbnail JPEGs | `thumbnails` at `/data/thumbnails` | Optional; can be regenerated |
| Original MP4 files | Host bind mount at `/archive` | Covered by your NAS backup |

Default volume names are `unifi-archive_postgres-data` and `unifi-archive_thumbnails`.
`docker compose down` preserves them. **`down -v` deletes database data; never use it for updates.**
The thumbnail volume inherits uid/gid 1000 ownership on first creation and survives container
restarts. Web/worker/migrate run as uid/gid 1000 with a read-only root filesystem,
`cap_drop: ALL` and `no-new-privileges`. Node is PID 1 and handles signals directly. Only the
thumbnail volume is writable. Request-dynamic pages and ffmpeg outputs do not need a writable
`/tmp` or Next cache; no explicit tmpfs or additional temporary volume is used. The unused Next
image optimizer is disabled so it cannot re-cache private JPEGs or write an image cache.
No privileged app containers, Docker socket or unrelated host directories are mounted. PostgreSQL's upstream entrypoint
initializes its volume and then runs the database under its own unprivileged user.

## NAS mount and outage protection

Example host path: `/mnt/nas/unifi-archive`. Compose uses a **read-only** long-syntax bind mount
with `create_host_path: false`: a typo or missing directory fails instead of creating a substitute.
The app never deletes, moves, renames or changes permissions on archive files. Thumbnails go
only to their own volume. Ensure uid 1000 or `NAS_ARCHIVE_GID` can read the host archive;
adjust the mount's access settings as appropriate, rather than changing original file permissions.

For network shares, set `ARCHIVE_REQUIRED_FS_TYPE` to the result of `findmnt -T <archive-path>`
(e.g. `nfs4` or `cifs`). This checks the filesystem behind the bind mount. The old
`ARCHIVE_REQUIRED_MOUNT` check remains available for local CLI use; a Docker bind mount alone
cannot prove that the NAS is mounted on the host.

If the NAS disappears and leaves an empty directory, scans are rejected when previously present
clips exist. A sudden loss of more than half of at least 50 clips is also rejected. Failed scans
never advance the successful-scan watermark, so existing clips are not mass-marked missing.
The worker continues heartbeats and reconciliation and retries later. If a large deletion really
was intentional, an administrator can run `node cli/archive-scan.mjs --accept-missing` manually.

The portable default is `rprivate`: after remounting the NAS, run
`docker compose restart web worker`. Optional `rslave` propagates host mount changes when the
source is shared/slave; verify this on your host. Real NFS/SMB disconnection and propagation
behaviour depend on the host/kernel and need an installation-specific test. The automated suite
simulates an empty/unreadable archive and checks filesystem-type mismatch.

## Optional UniFi Protect

```dotenv
UNIFI_PROTECT_URL=https://protect.example.com
UNIFI_PROTECT_API_KEY=<integration-api-key>
UNIFI_PROTECT_TLS_VERIFY=false
```

Only disable certificate verification when needed for the Protect console. This setting affects
its HTTP/WebSocket clients exclusively; never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
Bridge networking is sufficient; the worker reconnects with backoff and keeps scanning if Protect
is unavailable. It synchronizes cameras, receives Protect events and reconciles metadata.

Without Protect, indexing, archive browsing, playback and reconciliation work without an API key.
The existing conservative temporal matcher requires known camera identities: if Protect has never
synchronized cameras, each unknown-camera clip stays a separate event. Once cameras have been
synchronized, temporal multi-camera grouping also works with Protect disabled. This distribution
does not change matching rules or add a camera-management product feature.

## Health, logs and shutdown

```bash
docker compose ps -a
docker compose logs -f worker
docker compose logs web
docker compose logs migrate
docker compose logs postgres
docker compose exec worker node cli/worker-health.mjs
docker compose exec web node cli/media-check.mjs
```

PostgreSQL uses `pg_isready`. Web checks `/api/health` with a small database query (200/503,
no configuration details). Worker health uses its real persisted heartbeat and running state;
a blocked event loop becomes unhealthy when the heartbeat expires. Disabled/unreachable Protect
alone does not make the worker unhealthy. Docker health status does not itself restart containers;
`unless-stopped` restarts exited web/worker/postgres processes. Logs use the Docker host logging driver/defaults. Compose defines no logging override.
Use `docker compose logs -f web` / `worker` when the selected driver supports reading logs.
The administrator must arrange suitable host log rotation; the default json-file driver can
grow without a size limit. This project does not change `/etc/docker/daemon.json` or add log services.

SIGTERM/SIGINT reach Node directly as PID 1; no init wrapper is configured. The worker stops scheduling,
closes Protect, finishes/aborts work, releases advisory locks and closes database connections.
The CLI gives running work a six-second budget and exits by eight seconds if cleanup blocks.
Docker uses its host/default stop timeout (normally ten seconds on Linux); no service override
is configured. Interrupted atomic work is retried safely on restart. Active ffmpeg children are
terminated/reaped by the web process; partial cache files are never published as completed JPEGs. Database connection/leadership loss fails closed; the restart
policy brings back a fresh worker when PostgreSQL is reachable. Writes remain transactional and
reconciliation/event upserts idempotent. Next.js handles shutdown through its standalone server.

## Migrations and updates

Startup order: **PostgreSQL healthy → migration exits successfully → web and worker**.
The runtime Drizzle migrator applies pending SQL migrations in one transaction under an advisory
lock. It uses the existing migration bookkeeping table and is safe to rerun. On a fresh database,
Drizzle may create its empty bookkeeping schema/table before the migration transaction; failed
SQL changes and migration records are rolled back. No schema resets;
web/worker do not run competing migrations. An older image is refused when the schema is newer.

```bash
# Back up first, then select the reviewed version in compose.yaml or UNIFI_ARCHIVE_IMAGE.
# Never replace an existing version tag with different content.
docker compose pull
# Stop the old application before changing its schema.
docker compose stop web worker
docker compose up -d
docker compose logs migrate
docker compose ps -a
```

Stopping the old app first matters: Compose dependencies gate new startup, but do not stop already
running containers when a migration fails. If migration fails, leave web/worker stopped, inspect
the migration log, fix the cause and rerun the update. Database/cache volumes remain intact.
PostgreSQL major upgrades require a planned dump/restore, never replacing 18 with another major
against the same data volume. Backups are required before updates; migration rollback does not
undo migrations that succeeded in an earlier update.

## Backup and restore

Back up database metadata regularly and keep a copy away from the Docker host. Archive MP4s
are backed up separately on the NAS. Thumbnails are disposable cache data.

```bash
# Replace database/user below if configured differently.
docker compose exec -T postgres pg_dump -U unifi_archive -d unifi_archive -Fc > archive.dump
docker compose exec -T postgres pg_restore --list < archive.dump
```

Test a backup first in a separate project (own database volume; no web/worker needed):

```bash
docker compose -p unifi-archive-restoretest up -d --wait postgres
docker compose -p unifi-archive-restoretest exec -T postgres pg_restore -U unifi_archive -d unifi_archive --no-owner --exit-on-error < archive.dump
docker compose -p unifi-archive-restoretest exec -T postgres psql -U unifi_archive -d unifi_archive -c 'select count(*) from archive_events'
# Only this isolated restore test's volumes may be deleted:
docker compose -p unifi-archive-restoretest down -v
```

A real restore replaces database contents: make an additional backup first. Stop web/worker, restore the chosen compatible backup into the database
(`pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction`), then run `docker compose up -d`
to apply any pending migrations before restarting the app. Never restore over a running worker.

## Caddy / reverse proxy

For Internet/untrusted access, use an authenticating reverse proxy for every request, including `/api/clips/*`,
HEAD, Range and conditional requests. Protecting only the HTML pages is insufficient.
The [access boundary guide](security.md) contains the Caddy + Authentik forward-auth recipe,
provider/outpost prerequisites and anonymous/revoked-access tests. A plain
`reverse_proxy 127.0.0.1:3100` provides no authentication and is not an Internet deployment recipe.

In proxy-protected mode, set `UNIFI_ARCHIVE_BIND_IP=127.0.0.1`; PostgreSQL and worker have no published ports. Do not add
an all-interface/IPv6 publication, host networking or direct routing to bypass the proxy.
Local host processes, Docker administrators and containers deliberately attached to the app's
networks are outside the external authentication boundary. A containerized proxy's loopback is
its own container; adapt its connection privately rather than exposing the application publicly.

## Private media and external logout

All thumbnail and video responses use `Cache-Control: no-store`, including server-cache hits,
HEAD, 206 ranges, explicit 304 responses, 416 and errors. Health status also remains no-store.
Fingerprinted Next.js assets retain their usual immutable cache policy.
The persistent JPEG cache in the `thumbnails` volume remains enabled; HTTP storage prevention
does not force repeated ffmpeg generation. Versioned media URLs and ETags remain valid.

Unifi Protect Archive UI has no session/logout API. After Authentik or another gateway revokes access,
every new request must be denied before reaching the backend. Existing downloaded files,
older HTTP cache entries, screenshots, already displayed frames and in-flight responses cannot
be remotely erased by these headers. Close sensitive tabs/use a private browser profile on
shared devices. Follow the gateway's session-revocation procedure; do not assume closing one tab
revokes an SSO session. See [security.md](security.md) for scope and acceptance checks.

## Troubleshooting

| Symptom | Action |
|---|---|
| Missing required Compose variable | Set password and archive path in `.env` |
| Bind source path does not exist | Mount the NAS first and verify the host path |
| Archive permission denied | Verify uid 1000 / configured GID has read access |
| Shared/slave propagation error | Use default `rprivate`, or configure the host mount correctly |
| Scan refused: no MP4 files found | Check NAS availability; existing clips stay present |
| Migration fails | Read `logs migrate`; keep old app stopped while resolving it |
| Authentication failed for database user | Check the original DB password; `.env` alone does not rotate it |
| Worker exit 2 | Invalid settings; the log lists configuration errors |
| Protect authenticationError | Correct API key and recreate worker: `docker compose up -d worker` |
| Protect reconnecting | Check console URL/network/TLS; NAS jobs continue |
| Thumbnails missing | Run `node cli/media-check.mjs`; check ffmpeg and cache write access |
| Web health 503 | Check PostgreSQL and migration logs |
| Port occupied | Change `UNIFI_ARCHIVE_PORT`; the selected host-IP binding is retained |

Maintenance bundles are available in the common image: `cli/archive-scan.mjs --dry-run`,
`cli/archive-reconcile.mjs --dry-run`, `cli/protect-sync-cameras.mjs`, `cli/media-check.mjs`,
`cli/worker-health.mjs`, `cli/migrate.mjs`. Use `docker compose exec worker node ...` or the web
container for media checks. Concurrent jobs are coordinated by existing advisory locks.

## Validation and resource observations

See the [testing guide](testing.md) for reproducible checks. Resource samples are workload-specific;
no universal CPU/RAM minimum is claimed. Allow space for the image, database and growing cache.
The image has been tested on Linux amd64; other architectures and real NAS mount propagation
require their own verification.

## Prebuilt images and local release candidates

Web/worker/migrate use the same versioned image; only PostgreSQL uses its official `postgres:18`.
There are no production `build` directives. Users pull anonymously without `docker login ghcr.io`. Prefer immutable version/digest references,
not only `latest`. An image rollback does not undo database migrations.

For a privately built local candidate only, set `UNIFI_ARCHIVE_IMAGE` to its existing local tag.
Use `docker compose up -d --pull never` in an isolated test project to prevent accidental registry
access. This proves source-tree-free runtime, not GHCR availability.

Shutdown also cancels only the current worker's tracked PostgreSQL sessions (including heartbeat)
through a short-lived bounded connection, so a blocked server query does not keep an advisory lock
after the client exits. If the database/handshake is unreachable, the eight-second CLI watchdog
still bounds process exit; retries/recovery remain necessary. No unrelated database session is canceled.
