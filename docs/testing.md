# Testing

Tests use temporary synthetic archives and disposable metadata; never point them at a production
DB/NAS. Node24 and PostgreSQL18 are required. Browser tests additionally require ffmpeg/Chromium.

| Layer | Command | Scope |
|---|---|---|
| Unit | npm run test:unit | Parser, time/filter/group rules, filesystem/media, configuration/status |
| DB | npm run test:db | Source repositories, scanner, matching, worker/locks, query filters/migrations |
| Browser | npm run test:e2e | Production server, generated clips, desktop/mobile UI/media/security |
| Distribution | npm run test:docker | Own Compose projects/volumes, fake Protect, image/runtime/outages |
| Publication | npm run publication:check | Narrow tracked-source hygiene policy, not a general secret scanner |

## Development checks

Use Node 24, PostgreSQL 18 and ffmpeg for development, or the separate development container in
[compose.dev.yaml](../compose.dev.yaml). Development scripts read a private `.env.local`; production
Compose reads `.env`. Never point tests at the production database or NAS.

```bash
npm ci
npm run typecheck
npm run lint
npm run db:check
npm run db:generate       # a clean schema generates no migration
npm run test:unit
npm run test:db           # disposable TEST_DATABASE_URL server
npm run test:e2e          # synthetic footage and an isolated E2E database
npm run build
npm run build:cli
npm run publication:check
npm run test:docker       # isolated projects/volumes, synthetic archive, fake Protect
```

npm test runs unit plus DB projects. TEST_DATABASE_URL identifies a disposable server where the
user may create/drop databases. Vitest creates unique names/templates and removes only its own DBs.
E2E recreates unifi_archive_e2e and generates clips under .cache/e2e. Explicit environment values
keep local production .env files out of the server under test.

## Browser setup

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

The suite starts a standalone production build, uses one worker and no retries. It checks search,
periods/combined filters, pagination/history, thumbnails/multi-camera views, playback/seeking,
status and a synthetic streaming authorization gate. Cache tests do not intercept requests or disable
Chromium HTTP caching. Fingerprinted assets retain caching while private media use no-store.

E2E fixtures are relative to today in Europe/Berlin: a run crossing midnight needs fresh preparation,
not relaxed calendar assertions. Screenshot tests are optional (SCREENSHOTS); retain only synthetic
images and review them before public distribution. No screenshots are currently committed.

## Docker and development container

Use compose.dev.yaml explicitly for development. The optional Playwright service uses a matching
Playwright image and a remote browser endpoint; see compose.dev.yaml. Production Compose does not
add a browser/proxy/auth service. Docker distribution tests build one image, use unique project names,
read-only generated archives and fake Protect, and clean only their own containers/networks/volumes.
Set RUN_DOCKER_E2E=1 after installing Chromium to include production-container browser checks.
A private privileged DinD daemon is used by GitLab CI; no host socket is passed to the job.

Permission tests deliberately skip as root; rerun the scanner/thumbnail/indexer permission cases
as an unprivileged user. REQUIRE_FFMPEG=1 prevents silently skipping real ffmpeg tests in CI.
Large grouping tests default to 20,000 clips; RECONCILE_VOLUME_CLIPS=100000 enables the larger
optional benchmark. Do not treat synthetic timing samples as universal hardware requirements.

## Publication checker

The checker evaluates Git-tracked files and a machine-readable public-path policy. Before release,
add intended new files through the reviewed workflow or supply a candidate file list only in an
isolated test workspace. It flags environment/key/data artifacts, token-shaped values and unwanted
development artifacts without logging contents. Its policy contains no private installation values
or their hashes. Only the documented, intentionally public test TLS key has an integrity pin.
Device IDs, private network details and custom secrets still require contextual manual review;
the checker cannot determine their provenance from their format. AGENTS.md and private audit/release work reports are excluded
from the planned public export, not deleted from development. It does not scan remote artifacts,
unreachable Git objects or arbitrary secret formats; manual/current/history review is still required.

## Functional Docker tests and host-security gate

Functional scenarios use explicit loopback or an isolated Docker bridge address, never a public
all-interface bind. Compose parsing verifies the production 0.0.0.0:3100 default without publishing
it. Bridge-client checks exercise direct host-IP access, media and locales without DNS or a proxy.
`npm run test:docker` completes the functional matrix on Engine 26 and prints separate security
results. Engine >=28 remains required for supported localhost boundary acceptance.
`REQUIRE_DOCKER_SECURITY=1` makes an unsatisfied security gate fail the final exit status after
functional scenarios finish; the GitLab DinD runner sets it. No gate is silently removed or marked
as passed on an older daemon. Browser tests use synthetic media and also validate legal/source links.

## Prebuilt release candidates

`npm run release:build` exports the allowed public files into `.cache/release/source` and builds
a candidate from exactly that context. It writes source/image/native metadata and a local image
archive without any registry push. Run the full distribution suite with `DOCKER_TEST_IMAGE` set
to that existing tag. Tests create separate volumes/projects and never use real NAS/Protect keys.
The source-free scenario contains only `compose.yaml` and `.env`, with its archive outside the
installation directory. Source archive creation is local preparation, not GitHub publication.

Process tests use direct Node PID 1, host-default logging and Docker's default stop timeout.
They exercise blocked scan/reconciliation recovery and an actual ffmpeg during web shutdown.
The worker does not generate thumbnails; that process test belongs to web.
