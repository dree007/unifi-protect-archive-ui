# Changelog

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
