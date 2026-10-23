# Changelog

## 2.1.0

No database migration.

### Added

- Dark mode: a sun–moon switch at the bottom of the sidebar (a round button in the mobile top
  bar). Without a choice the app follows the system setting; the choice is kept per browser.
  The logo and the browser tab icon adapt to the dark theme.
- Optional built-in login: set `APP_LOGIN_USERNAME` and `APP_LOGIN_PASSWORD` to require a
  sign-in for every page and API (health check excepted), with a sign-out button. Without them
  nothing changes and there is no login screen. See docs/security.md.
- The desktop sidebar folds to an icon rail with a small handle on its edge and remembers the
  state per browser.

### Changed

- A little more color: pastel hues for the navigation icons, the dashboard figures, detection
  types (badges, bars and the latest-detection card) and camera icons. "Fine" states such as
  running or online are now sage green instead of violet.

## 2.0.1

Patch release. No database migration; upgrading from 2.0.0 only needs the new image.

### Changed

- New logo: a stack of archive folders with a play button, drawn in the Atelier Soft colors. It
  replaces the camera icon in the sidebar and as the browser tab icon.
- The README screenshots show calm, lightly pixelated illustrated scenes instead of video test
  patterns.

## 2.0.0

Major release: a new name, a new visual design and a database migration.

### Upgrade

- Back up the database before upgrading (docs/selfhosting.md, "Backup and restore"). The `migrate`
  service applies migration `0005_favorites_collections` on startup; it only adds three empty
  tables and changes no existing data.
- After the migration, version 1.x refuses to start against the database. Going back means
  restoring the backup.
- The Compose file, image name, environment variables and data volumes are unchanged; only the
  default image tag moves to `2.0.0`.

### Added

- Favorites and collections: mark an event (a situation, with all its recordings) as favorite
  and organize events in your own collections (for example "Front door" or "Parcel deliveries").
  An event can be in several collections. Under the archive's search field, "Favorites" and every
  collection are chips that filter the archive and combine with all other filters; "Manage
  collections" creates, renames and deletes them. Only metadata is stored; the videos on the NAS
  stay untouched. The database migration adds three empty tables.
- Clips whose file the latest complete archive scan no longer found are marked as no longer in
  the archive on the event page.

### Changed

- New visual design "Atelier Soft": warm eggshell surfaces, ink text, soft shadows, pill-shaped
  buttons, tags and tabs, and the fonts Inter, Inter Tight and Geist Mono (self-hosted, no
  requests to Google). Pages, navigation and functions are unchanged.
- The product is now called "Protect Archive UI" (web interface, page titles, image label, log
  output and documentation). Image and repository names are unchanged.
- Events without detections are titled by their cameras ("Driveway + Doorbell") instead of
  "Archived clip"; touch screens get 44 px targets; the event page shows its facts and notes
  without nested boxes.

## 1.1.0

Minor release.

### Added

- "Play together": events with two or more clips can play two of them side by side (stacked on
  phones), synchronized by recording time, with one shared play/pause control and timeline. With
  more than two clips, each side can switch its clip. Both videos start muted; at most one is
  audible.

### Changed

- Events that are still waiting for their recording disappear from the archive list and the
  dashboard three minutes after the event, until a clip is linked. Nothing is deleted; detail
  links keep working and the system page still counts them.
- The public GitHub repository contains only what is needed to run and rebuild the application:
  tests, CI configuration, development tooling and developer documentation stay in the private
  development repository.

### Fixed

- Archive files whose names carry a time zone abbreviation instead of a GMT offset (for example
  `CDT` or `EST`, as written by UniFi Protect in North American time zones) are now indexed
  instead of being rejected. Unknown abbreviations are still rejected, never guessed.

## 1.0.1

Patch release.

### Changed

- The production Compose file is now `docker-compose.yml` (formerly `compose.yaml`). Existing
  installations keep working; to switch, replace the local `compose.yaml` with the new file. Do not keep both, because Docker
  Compose prefers `compose.yaml`. The project name and volumes are unchanged.
- `.env.example` lists only the common settings. Advanced settings (worker intervals, NAS mount
  checks, database name/user, thumbnail concurrency) remain supported and are documented in
  `docs/selfhosting.md`; local development values moved to `docs/testing.md`.

### Fixed

- Release publishing verifies the pushed tag with image index media types, so the post-push
  digest check no longer fails for images pushed as an OCI index (Docker 29).
- Temporal fallback grouping now also works without any Protect connection: clips whose camera is
  not resolved take part under the camera name from their file name. Previously, a NAS-only
  installation never grouped simultaneous clips of different cameras.

## 1.0.0

First public self-hosted release.

### Added

- Read-only indexing of supported UniFi Protect NAS MP4 exports into PostgreSQL.
- Dashboard, archive, camera and system views with search, camera/detection/date filters and pagination.
- Original video playback with HTTP Range/seeking and persistent ffmpeg thumbnail caching.
- Optional Protect Integration API camera synchronization and live WebSocket event collection.
- Metadata matching, conservative temporal fallback, multi-camera grouping and reversible re-evaluation.
- Background scans, reconciliation, persisted component status, heartbeats and healthchecks.
- One application image for web, worker and automatic one-shot migrations; PostgreSQL 18 persistence.
- German/English interface, weighted browser-locale detection, persistent language toggle and localized formatting.
- Locale-independent detection search including Licence plate, License plate, Kennzeichen and licensePlate.
- Simple default LAN access through the Docker host IP and port; optional loopback/protected-proxy mode.
- AGPL-3.0-only licensing, legal/source links and retained third-party notices.

### Security and deployment

- Private media responses use no-store while server-side thumbnails remain cached.
- Non-root read-only application containers, dropped capabilities, no-new-privileges and read-only NAS mounts.
- PostgreSQL/worker/migrate have no published ports; exactly one configurable web host port.
- Failed/empty NAS scans preserve prior index presence; migrations gate web/worker startup.
- Simplified explicit-service Compose configuration; existing project/volume identities retained.
- Functional Docker tests run independently of the separate Engine >=28 host-security gate.
- Prebuilt Linux amd64 image `ghcr.io/dree007/unifi-protect-archive-ui:1.0.0`, with the matching
  application source (`source.tar.gz`) and native third-party sources (`native-source.tar.gz`) attached
  to the GitHub release.
- Production Compose no longer defines build, init, stop_grace_period or logging overrides; process shutdown and host-log responsibilities are explicit.

### Limits

- The default LAN listener has no authentication or HTTPS. Restrict it to trusted networks.
- Protect events are collected live; missed/historical vendor events are not backfilled.
- Timestamp grouping is heuristic; playback selects one camera clip, not synchronized multi-camera playback.
- Generic MP4 import, built-in users and native mobile applications are outside v1.0.
- Tested on Linux amd64 with synthetic recordings and a simulated Protect console. Linux arm64, real
  NAS mount recovery, specific Protect versions and real HTTPS/single sign-on setups are not tested.
