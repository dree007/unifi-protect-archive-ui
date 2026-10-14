# Web interface

The responsive pastel interface provides dashboard, archive, event detail, camera and system
pages. The product is Unifi Protect Archive UI, with German and English interfaces. Language
choice, persistence and formatting are described in [Internationalization](internationalization.md).
All pages use live PostgreSQL queries, not bundled installation/demo data.

Archive filters combine free-text search, camera UUID, detection type, detected-only and calendar
period (all/today/7d/30d/custom). Search is normalized and length-bounded. Date-only inputs use
APP_TIME_ZONE for day boundaries; stored timestamps are absolute. Invalid dates are explained;
start after end is not silently swapped. Unknown filter values fall back safely.

Free text matches camera names, filenames and Protect event IDs. An exact known DE/EN detection
label or technical type name also matches linked detections, regardless of UI language. For example,
`Licence plate`, `License plate`, `Kennzeichen` and `licensePlate` all match `licensePlate`.
Search alternatives remain OR-connected; camera, period and detection filters remain AND-connected.

URL parameters preserve navigation/history. Keyset pagination loads more results without duplicates.
Server-rendered thumbnail/filter links remain useful without hydration. Desktop supports an event
side panel; mobile uses detail navigation. Multi-camera events expose camera tabs, provenance and
per-camera metadata; playback is one selected clip, not synchronized multi-camera playback.

System status distinguishes fresh, running, stale, stopped and failed components using persisted
heartbeat/instance ownership. An unreachable Protect stream is shown independently of NAS work.
Health/status text is sanitized. No app login or per-camera authorization is provided; every page
and media/API route must sit behind the [external boundary](security.md) for network access.
