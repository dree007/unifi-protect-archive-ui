# NAS indexer

The indexer reads existing UniFi Protect MP4 exports and persists metadata. It never modifies,
renames or deletes originals. ARCHIVE_ROOT must be absolute and readable. Production mounts it
read-only at /archive; development can use a read-only bind such as /mnt/nas/protect-archive.

## Supported layout

```text
UniFi-Protect_2026-01-15/
  Driveway 1-15-2026, 1.01.05pm GMT+1 - 1-15-2026, 1.02.18pm GMT+1.mp4
2026-01-16/
  Garden 1-16-2026, 8.00.00am GMT+1 - 1-16-2026, 8.00.12am GMT+1.mp4
```

Both plain and prefixed day folders are accepted. Camera names, filename start/end and GMT
offsets are parsed; timestamps do not depend on host locale. Spaces and Unicode are supported.
Unknown filename shapes are reported rather than guessed. A day-folder/filename date mismatch
is a warning; the filename time is primary. Symlinks and unrelated entries are ignored.

## Running

```bash
npm run archive:scan
npm run archive:scan -- --dry-run
npm run archive:scan -- --verbose
```

The worker runs the same implementation automatically. Database batches record seen paths,
size/mtime/time fields and a scan-run history. One advisory lock serializes full scans. Exit codes:
0 success, 1 failed/not started, 2 invalid arguments. A dry run parses/stats without database writes.
The runtime image also exposes cli/archive-scan.mjs.

## Missing and mount safety

Only a completed scan advances the successful missing watermark. A failed/aborted scan can have
persisted seen batches but cannot declare the rest missing. Listed-but-unreadable known files
remain present; a genuinely vanished file can become missing after a successful scan.

An empty scan is refused if previously present clips exist. Losing over half of at least 50 clips
is also refused by default. For a genuine intentional large deletion, a maintenance operator may
use --accept-missing; never use it to conceal a missing NAS mount.

Production's create_host_path:false rejects nonexistent paths but cannot prove an existing empty
directory is the real share. Set ARCHIVE_REQUIRED_FS_TYPE (for example nfs4,cifs), verify mount
permissions, and follow [mount recovery](selfhosting.md#nas-mount-and-outage-protection).
ARCHIVE_REQUIRED_MOUNT is available for local CLI use. Real mount lifecycle tests must use a
separate test share, read-only footage and disposable metadata, not a production disconnect.
