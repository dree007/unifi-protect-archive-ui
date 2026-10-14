# Video and thumbnails

Media APIs accept clip UUIDs and look up stored relative paths; browsers never provide filesystem
paths. Original videos remain unchanged on the read-only archive. ffmpeg produces JPEG previews
in the independent persistent thumbnail volume.

| Method | Endpoint | Statuses |
|---|---|---|
| GET / HEAD | /api/clips/[clipId]/video | 200, 206, explicit 304, 404, 416, 503 |
| GET | /api/clips/[clipId]/thumbnail?v=<version> | 200, explicit 304, 404, 422, 503 |

## File and streaming safety

Stored paths reject absolute/dot/traversal/backslash/NUL components. Realpath checks reject links
below the root; O_RDONLY/O_NOFOLLOW opens once and Linux descriptor-path checks guard directory
swaps. fstat and streaming use that descriptor. Missing/unreadable/archive/database errors return
generic responses without filesystem/credential details. Handles close on HEAD/early responses,
completion and cancellation; streaming uses backpressure rather than full-video buffering.

Exactly one byte range is supported, including suffix/open-ended forms. Valid ranges return 206
with Content-Range/Length; malformed/multiple/unsatisfiable ranges return 416. HEAD follows the
same logic without a body. ETag/Last-Modified and explicit If-None-Match/If-Range remain supported.

## HTTP privacy versus server cache

Every private media response uses Cache-Control:no-store, including ranges, HEAD, explicit 304,
cache hits and errors. This does not disable the server JPEG cache. Fingerprinted Next assets keep
normal immutable caching. External authentication must protect the media URLs too; see
[Access security](security.md) for the precise logout/download/in-flight limitations.

Cache keys use UUID plus indexed file mtime/size. ffmpeg receives the checked descriptor, never
an interpolated shell command. It extracts one frame near 22% of the recorded interval with a
start-of-file fallback, at most 640px wide, no upscaling. Temporary JPEGs are atomically renamed;
failure removes partial output. Defaults are two simultaneous renders, 20-second timeout and a
brief failed-file cache; old disk entries are not automatically pruned.

The thumbnail cache must be writable and outside the archive, including through symlink parents.
Errors identify generic causes via X-Thumbnail-Error (ffmpeg-missing, ffmpeg-timeout, no-frame,
cache-unavailable), never secret/path details. The UI uses a placeholder when generation fails.

```bash
npm run media:check
npm run media:check -- --clip-id <synthetic-or-authorized-clip-uuid>
```

Runtime uses Debian ffmpeg. Playback codecs depend on the browser: the app does not transcode
original H.264/H.265 to make every browser compatible. Tests generate synthetic VP9 browser clips
and real ffmpeg H.264/H.265 fixtures; no original private recording is committed.
