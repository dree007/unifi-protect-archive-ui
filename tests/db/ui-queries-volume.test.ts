import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { DEFAULT_ARCHIVE_FILTERS, type ArchiveFilters } from "@/lib/archive-filters";
import { getArchivePage } from "@/server/queries/archive";
import { queryContext } from "@/server/queries/context";
import { getDashboard } from "@/server/queries/dashboard";

import { createIsolatedDb } from "./helpers";

const EVENTS = 20_000;

/**
 * 20,000 archive events (5 cameras, one clip each, every 4th with a Protect "person" event,
 * every 20th "vehicle"), built directly in SQL. Reports timings; no hard time limits.
 */
describe("UI queries on 20,000 archive events", () => {
  it("pages and filters without loading the whole archive", { timeout: 120_000 }, async () => {
    const { db } = await createIsolatedDb();
    await db.execute(sql`
      insert into cameras (protect_device_id, name, state)
      select 'cam' || lpad(i::text, 21, '0'), 'Kamera ' || i, 'online' from generate_series(1, 5) i`);
    await db.execute(sql`
      insert into archived_clips (camera_id, camera_name, start_at, end_at, duration_ms, file_path, file_name, file_size_bytes, day_directory)
      select c.id, c.name, ts, ts + interval '30 s', 30000, 'd/' || i || '.mp4', 'Clip ' || i || '.mp4', 1000000, 'd'
      from generate_series(1, ${EVENTS}) i
      cross join lateral (select '2026-10-06T10:00:00Z'::timestamptz - i * interval '97 s' as ts) t
      join (select id, name, row_number() over (order by name) - 1 as n from cameras) c on c.n = i % 5`);
    await db.execute(sql`
      insert into protect_events (protect_event_id, camera_id, protect_device_id, event_type, start_at, end_at, smart_detect_types, first_received_at, last_received_at)
      select 'pe-' || c.id, c.camera_id, cam.protect_device_id, 'smartDetectZone', c.start_at + interval '2 s', c.start_at + interval '10 s',
             case when row_number() over (order by c.start_at) % 20 = 0 then array['vehicle'] else array['person'] end,
             c.start_at, c.start_at
      from archived_clips c join cameras cam on cam.id = c.camera_id
      where (extract(epoch from c.start_at)::bigint / 97) % 4 = 0`);
    await db.execute(sql`
      with events as (
        insert into archive_events (id, start_at, end_at, metadata_status)
        select uuidv7(), c.start_at, c.end_at, 'archiveOnly' from archived_clips c
        returning id, start_at)
      insert into archive_event_clips select e.id, c.id, e.id from events e join archived_clips c on c.start_at = e.start_at`);
    await db.execute(sql`
      insert into archive_event_protect_events
      select l.archive_event_id, p.id, l.archive_event_id from protect_events p
      join archived_clips c on c.id = p.id or (c.start_at = p.start_at - interval '2 s' and c.camera_id = p.camera_id)
      join archive_event_clips l on l.archived_clip_id = c.id`);
    await db.execute(sql`update archive_events e set metadata_status = 'matched'
      where exists (select 1 from archive_event_protect_events l where l.archive_event_id = e.id)`);
    await db.execute(sql`analyze`);

    const context = queryContext({ db, now: new Date("2026-10-06T10:00:00Z"), timeZone: "Europe/Berlin" });
    const camera = (await db.execute<{ id: string }>(sql`select id from cameras order by name limit 1`)).rows[0].id;
    const timings: string[] = [];
    const time = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await run();
      timings.push(`${label}: ${(performance.now() - started).toFixed(1)} ms`);
      return result;
    };
    const page = (patch: Partial<ArchiveFilters>, cursor: string | null = null) =>
      getArchivePage({ ...DEFAULT_ARCHIVE_FILTERS, ...patch }, cursor, context);

    const first = await time("first page", () => page({}));
    const second = await time("next cursor page", () => page({}, first.nextCursor));
    const byCamera = await time("camera filter", () => page({ cameraId: camera }));
    const byType = await time("detection filter (vehicle)", () => page({ detection: "vehicle" }));
    const detected = await time("only with detection", () => page({ onlyDetected: true }));
    const today = await time("period today", () => page({ period: "today" }));
    const search = await time("search (file name)", () => page({ query: "Clip 19999" }));
    // Worst cases: nothing matches, so every event has to be checked.
    const noSearchHit = await time("search without hits (worst case)", () => page({ query: "gibt-es-nicht" }));
    const noTypeHit = await time("detection filter without hits (worst case)", () => page({ detection: "package" }));
    await time("dashboard", () => getDashboard(context));
    console.log(`UI queries on ${EVENTS} archive events:\n  ${timings.join("\n  ")}`);

    expect(first.events).toHaveLength(30);
    expect(second.events).toHaveLength(30);
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(60);
    expect(byCamera.events.every((e) => e.cameras.some((c) => c.key === camera))).toBe(true);
    expect(byType.events.length).toBeGreaterThan(0);
    expect(byType.events.every((e) => e.detectionTypes.includes("vehicle"))).toBe(true);
    expect(detected.events.every((e) => e.detectionTypes.length > 0)).toBe(true);
    expect(today.events.length).toBeGreaterThan(0);
    expect(search.events.map((e) => e.cameras.length)).toEqual([1]);
    expect(noSearchHit.events).toEqual([]);
    expect(noTypeHit.events).toEqual([]);
  });
});
