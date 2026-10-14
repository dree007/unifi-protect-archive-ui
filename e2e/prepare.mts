// Prepares the deterministic environment for the browser tests (npm run test:e2e):
//
// - a database of its own, `unifi_archive_e2e`, on the TEST_DATABASE_URL server (dropped and
//   re-created, migrated) – never the app database,
// - a temporary archive under .cache/e2e/archive with small synthetic MP4s named like
//   real UniFi exports (`UniFi-Protect_YYYY-MM-DD/<Kamera> M-D-YYYY, h.mm.ssam GMT+2 - ….mp4`),
// - an empty thumbnail cache under .cache/e2e/thumbnails,
// then runs the real pipeline: NAS indexer → cameras + Protect events → reconciliation.
// Times are relative to "today" in Europe/Berlin, so "Heute" always has events.
// Writes nothing to ARCHIVE_ROOT or the app database. Needs ffmpeg (the dev container has it).
// The videos are VP9 in MP4: Playwright's Chromium has no proprietary codecs (H.264), and the
// browser tests must really play and seek. H.264/H.265 thumbnails: tests/unit/media-ffmpeg.test.ts.
import "../scripts/load-env.mts";

import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import { addDays, dayKeyInZone, startOfDayInZone } from "@/lib/time-zone";
import { runArchiveScan } from "@/server/archive/archive-indexer";
import * as schema from "@/server/db/schema";
import { reconcileArchive } from "@/server/matching/reconcile";
import { upsertCameras } from "@/server/repositories/cameras";
import { upsertProtectEvent } from "@/server/repositories/protect-events";

import { E2E } from "./environment.mts";

const run = promisify(execFile);
const TZ = "Europe/Berlin";

const serverUrl = process.env.TEST_DATABASE_URL;
if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set (see .env.example).");
if (new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname === `/${E2E.database}`) {
  throw new Error(`DATABASE_URL points at ${E2E.database}; refusing to touch the app database.`);
}

// --- database ---------------------------------------------------------------------------------
const admin = new Client({ connectionString: serverUrl });
await admin.connect();
await admin.query(`drop database if exists "${E2E.database}" with (force)`);
await admin.query(`create database "${E2E.database}"`);
await admin.end();
const pool = new Pool({ connectionString: E2E.databaseUrl(serverUrl) });
const db = drizzle({ client: pool, schema });
await migrate(db, { migrationsFolder: "drizzle" });

// --- archive with synthetic videos ----------------------------------------------------------
await rm(E2E.root, { recursive: true, force: true });
await mkdir(E2E.archiveRoot, { recursive: true });
await mkdir(E2E.thumbnailRoot, { recursive: true });
const sources = path.join(E2E.root, "sources");
await mkdir(sources, { recursive: true });
const SOURCE_SECONDS = 8;
for (const [name, pattern] of [["a.mp4", "testsrc2"], ["b.mp4", "smptebars"]] as const) {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${pattern}=size=640x360:rate=15:duration=${SOURCE_SECONDS}`,
    "-c:v", "libvpx-vp9", "-b:v", "300k", "-deadline", "realtime", "-cpu-used", "8",
    "-pix_fmt", "yuv420p", "-g", "15", "-y", path.join(sources, name),
  ]);
}

/** Wall clock in Berlin, for UniFi-style file names. */
function berlinParts(instant: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second" | "timeZoneName", string>;
}
function unifiTimestamp(instant: Date): string {
  const p = berlinParts(instant);
  const hour = Number(p.hour);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${p.month}-${p.day}-${p.year}, ${h12}.${p.minute}.${p.second}${hour < 12 ? "am" : "pm"} ${p.timeZoneName}`;
}

const today = dayKeyInZone(new Date(), TZ);
/** Instant of `HH:MM` local time, `daysAgo` days before today (Berlin). */
const at = (daysAgo: number, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return new Date(startOfDayInZone(addDays(today, -daysAgo), TZ).getTime() + (h * 60 + m) * 60_000);
};

const FIXED_MTIME = new Date("2026-01-01T00:00:00Z");
async function addClip(camera: string, start: Date, seconds: number, source: "a" | "b" = "a") {
  const end = new Date(start.getTime() + seconds * 1000);
  const dir = `UniFi-Protect_${dayKeyInZone(start, TZ)}`;
  const name = `${camera} ${unifiTimestamp(start)} - ${unifiTimestamp(end)}.mp4`;
  await mkdir(path.join(E2E.archiveRoot, dir), { recursive: true });
  const target = path.join(E2E.archiveRoot, dir, name);
  await copyFile(path.join(sources, `${source}.mp4`), target);
  await utimes(target, FIXED_MTIME, FIXED_MTIME);
}

// Today
await addClip("Garden", at(0, "08:00"), SOURCE_SECONDS);
await addClip("Driveway", at(0, "07:00"), SOURCE_SECONDS, "b");
await addClip("Doorbell", at(0, "07:00"), SOURCE_SECONDS); // same moment: multi-camera event
// Yesterday, 3 and 10 days ago
await addClip("Garden", at(1, "18:30"), SOURCE_SECONDS, "b");
await addClip("Driveway", at(3, "12:15"), SOURCE_SECONDS);
await addClip("Garage 2", at(3, "09:45"), SOURCE_SECONDS, "b");
await addClip("Garden", at(10, "10:00"), SOURCE_SECONDS);
// Many Garden clips (11–45 days ago): "Mehr laden" with and without filters
for (let daysAgo = 11; daysAgo <= 45; daysAgo++) await addClip("Garden", at(daysAgo, "06:30"), SOURCE_SECONDS, daysAgo % 2 ? "a" : "b");
// Multi-camera grouping without (complete) Protect metadata – far back, so the period counts above
// stay as they are. Doorbell/Garage start one second earlier and end at the same time.
const second = (date: Date, offset: number) => new Date(date.getTime() + offset * 1000);
await addClip("Driveway", at(50, "14:20"), SOURCE_SECONDS); // historic: temporal fallback only
await addClip("Doorbell", second(at(50, "14:20"), -1), SOURCE_SECONDS + 1, "b");
await addClip("Driveway", at(51, "16:10"), SOURCE_SECONDS); // mixed: Driveway with Protect, Garage 2 by time
await addClip("Garage 2", second(at(51, "16:10"), -1), SOURCE_SECONDS + 1, "b");
await addClip("Driveway", at(52, "11:05"), SOURCE_SECONDS); // split: grouped first, then contradicting detections
await addClip("Doorbell", second(at(52, "11:05"), -1), SOURCE_SECONDS + 1, "b");
await rm(sources, { recursive: true, force: true });

// --- real pipeline ------------------------------------------------------------------------------
const scan = await runArchiveScan({ archiveRoot: E2E.archiveRoot, db });
if (scan.failures.length > 0) throw new Error(`e2e scan failures: ${JSON.stringify(scan.failures)}`);

const DEVICES = {
  Driveway: "660000000000000000000002",
  Garden: "660000000000000000000001",
  Doorbell: "660000000000000000000003",
  "Garage 2": "65ddf35203abc803e4010d16",
} as const;
const cameras = await upsertCameras(
  Object.entries(DEVICES).map(([name, protectDeviceId]) => ({
    protectDeviceId,
    name,
    state: name === "Garage 2" ? "offline" : "online",
    protectState: name === "Garage 2" ? "DISCONNECTED" : "CONNECTED",
    smartDetectTypes: ["person", "vehicle", "animal", "package"],
    lastSeenAt: new Date(),
  })),
  db,
);
const cameraId = (name: keyof typeof DEVICES) => cameras.find((c) => c.camera.protectDeviceId === DEVICES[name])!.camera.id;
const protect = (camera: keyof typeof DEVICES, start: Date, types: string[], protectEventId: string, seconds: number | null = 5) =>
  upsertProtectEvent(
    {
      protectEventId,
      protectDeviceId: DEVICES[camera],
      cameraId: cameraId(camera),
      eventType: "smartDetectZone",
      startAt: start,
      endAt: seconds === null ? null : new Date(start.getTime() + seconds * 1000),
      smartDetectTypes: types,
      receivedAt: start,
    },
    db,
  );
await protect("Garden", new Date(at(0, "08:00").getTime() + 1000), ["person"], "e2e-garden-person");
await protect("Driveway", new Date(at(0, "07:00").getTime() + 1000), ["person", "vehicle"], "e2e-driveway-person");
await protect("Doorbell", new Date(at(0, "07:00").getTime() + 1500), ["person"], "e2e-doorbell-person");
await protect("Doorbell", at(0, "06:00"), ["package"], "e2e-pending-paket", null); // no clip: pending
await protect("Garage 2", new Date(at(3, "09:45").getTime() + 1000), ["animal", "licensePlate"], "e2e-terasse-animal");
await protect("Driveway", second(at(51, "16:10"), 1), ["person"], "e2e-mixed-driveway-person");

// First run groups the 52-days-ago pair by time; the detections arriving afterwards contradict
// each other, so the second run splits it again (person vs. vehicle).
await reconcileArchive({ db });
await protect("Driveway", second(at(52, "11:05"), 1), ["vehicle"], "e2e-split-driveway-vehicle");
await protect("Doorbell", second(at(52, "11:05"), 1), ["person"], "e2e-split-doorbell-person");
const reconcile = await reconcileArchive({ db });
if (reconcile.archiveEventsSplit !== 1 || reconcile.temporalFallbackEvents !== 2) {
  throw new Error(`e2e: unexpected grouping ${JSON.stringify(reconcile)}`);
}
const { rows } = await pool.query<{ events: number; clips: number }>(
  "select (select count(*)::int from archive_events) as events, (select count(*)::int from archived_clips) as clips",
);
await pool.end();
console.log(
  `e2e environment ready: ${rows[0].clips} clips, ${rows[0].events} archive events ` +
    `(${reconcile.clipEventMatches} clip/event matches) in ${E2E.database}; archive ${E2E.archiveRoot}`,
);
