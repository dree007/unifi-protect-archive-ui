# UniFi Protect integration

Optional read-only clients use the local Integration API. Configure UNIFI_PROTECT_URL,
UNIFI_PROTECT_API_KEY and UNIFI_PROTECT_TLS_VERIFY. Keep API keys in private runtime environment
files; never put them in source, images, browser props or URL query parameters.

```bash
npm run protect:sync-cameras
npm run protect:collect
npm run protect:collect -- --verbose
```

The worker provides camera synchronization and collection automatically. Do not run a second
collector concurrently; advisory locks coordinate worker/manual commands.

## API shape

- GET /proxy/protect/integration/v1/meta/info
- GET /proxy/protect/integration/v1/cameras
- WSS /proxy/protect/integration/v1/subscribe/events

Authentication is X-API-Key. Camera payloads are validated; identity uses device IDs and state
mapping retains unknown raw values. WebSocket add/update messages are ingested sequentially and
upserted by event ID. Partial updates use stored fields; malformed/irrelevant messages are skipped.
The synthetic corpus in tests/support/protect-fixtures.ts uses deterministic 24-hex device IDs,
locally administered MACs and UUID events at fixed timestamps, not recorded installation data.

## Transport and recovery

TLS verification defaults to true and is scoped to each client. Prefer a trusted console certificate;
only disable verification knowingly for an isolated trusted link. Never globally disable Node TLS.
HTTP requests have bounded response sizes and timeouts; redirects do not forward keys to new hosts.
The stream detects dead peers with ping/pong, uses backoff and pauses reads under database pressure.
401/403 is an authentication error, not a tight reconnect loop. Logs do not print keys; verbose
logs still contain event metadata and should remain private.

The Integration API is a live stream, not a historic event backup. Missed events are not backfilled.
NAS-only browsing works without Protect. Temporal multi-camera grouping needs known camera IDs;
without a prior camera sync, unknown-camera clips remain separate archive events.
See [Matching](event-matching.md), [Worker](background-worker.md) and [Selfhosting](selfhosting.md).
