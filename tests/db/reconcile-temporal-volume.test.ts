import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { TEMPORAL_FALLBACK_START_TOLERANCE_MS } from "@/server/matching/config";
import { reconcileArchive } from "@/server/matching/reconcile";

import { createIsolatedDb } from "./helpers";

/**
 * The upgrade path of a real archive: clips that already have one archiveOnly event each (as the
 * previous version left them), plus Protect events. 5 cameras; per slot of 5 minutes one of four
 * patterns (by slot % 4):
 *   0: all five cameras record nearly the same interval, no metadata → one fallback event
 *   1: cameras 0+1 with matching "person" events → one metadata event; cameras 2–4 40 s apart
 *   2: camera 0 "person", camera 1 "vehicle", nearly identical clips → two events; 2–4 apart
 *   3: a chain, each camera 2 s after the previous one → {0,1,2}, {3,4}
 * Default 20,000 clips; RECONCILE_VOLUME_CLIPS=100000 for the larger benchmark. Reports timings,
 * no hard time limit (only a generous bound against accidental O(N²)).
 */
const CLIPS = Number(process.env.RECONCILE_VOLUME_CLIPS ?? 20_000);
const CAMERAS = 5;
const SLOTS = CLIPS / CAMERAS;

describe("reconciliation volume with temporal fallback", () => {
  it(`groups ${CLIPS.toLocaleString("en-US")} historic clips correctly, deterministically and idempotently`, { timeout: 900_000 }, async () => {
    const { db } = await createIsolatedDb();
    await db.execute(sql`
      insert into cameras (protect_device_id, name, state)
      select 'cam' || lpad(i::text, 21, '0'), 'Kamera ' || i, 'online' from generate_series(0, ${CAMERAS - 1}) i`);
    // Start offset (ms) per pattern and camera; clips are 60 s long (pattern 1/2: 40 s apart for 2–4).
    await db.execute(sql`
      with cams as (select id, name, protect_device_id, (row_number() over (order by name) - 1)::int as n from cameras),
      slots as (select s, '2026-01-01T00:00:00Z'::timestamptz + s * interval '5 min' as base from generate_series(0, ${SLOTS - 1}) s),
      planned as (
        select s.s, c.id as camera_id, c.name, c.n,
          s.base + make_interval(secs => case s.s % 4
            when 0 then c.n * 0.5
            when 3 then c.n * 2
            else case when c.n < 2 then c.n * 0.5 else c.n * 40 end end) as start_at
        from slots s cross join cams c)
      insert into archived_clips (camera_id, camera_name, start_at, end_at, duration_ms, file_path, file_name, day_directory)
      select camera_id, name, start_at, start_at + interval '60 s', 60000,
             'd/' || name || ' ' || s || '.mp4', name || ' ' || s || '.mp4', 'd'
      from planned`);
    // Old state: one archiveOnly event per clip (its own primary group).
    await db.execute(sql`
      with events as (
        insert into archive_events (id, start_at, end_at, metadata_status)
        select uuidv7(), start_at, end_at, 'archiveOnly' from archived_clips order by start_at, id
        returning id, start_at)
      insert into archive_event_clips (archive_event_id, archived_clip_id, primary_group_id)
      select e.id, c.id, e.id from events e join archived_clips c on c.start_at = e.start_at`);
    // Protect events for cameras 0 and 1 in patterns 1 and 2 (inside their clips).
    await db.execute(sql`
      insert into protect_events (protect_event_id, camera_id, protect_device_id, event_type, start_at, end_at,
                                  smart_detect_types, first_received_at, last_received_at)
      select 'pe-' || c.id, c.camera_id, cam.protect_device_id, 'smartDetectZone', c.start_at + interval '2 s', c.start_at + interval '12 s',
             case when cam.name = 'Kamera 1' and (floor(extract(epoch from c.start_at - '2026-01-01T00:00:00Z') / 300))::int % 4 = 2
                  then array['vehicle'] else array['person'] end,
             c.start_at, c.start_at
      from archived_clips c join cameras cam on cam.id = c.camera_id
      where cam.name in ('Kamera 0', 'Kamera 1')
        and (floor(extract(epoch from c.start_at - '2026-01-01T00:00:00Z') / 300))::int % 4 in (1, 2)`);
    await db.execute(sql`analyze`);

    const timings: string[] = [];
    const timed = async (label: string) => {
      const started = performance.now();
      const result = await reconcileArchive({ db });
      const ms = performance.now() - started;
      timings.push(`${label}: ${(ms / 1000).toFixed(1)} s`);
      return { result, ms };
    };

    const quarter = SLOTS / 4;
    const first = await timed("first run (upgrade)");
    expect(first.result).toMatchObject({
      clipsTotal: CLIPS,
      protectEventsTotal: quarter * 4,
      clipEventMatches: quarter * 4,
      multiCameraEvents: quarter,
      temporalFallbackEvents: quarter * 3,
      // 5 cameras → 10 links; chain pattern: 3 + 1 pairs.
      temporalLinksAdded: quarter * 14,
      temporalLinksRemoved: 0,
      archiveEventsCreated: 0,
      archiveEventsSplit: 0,
      // Merged away: 4 per pattern 0, 1 per pattern 1 (metadata), 3 per pattern 3.
      archiveEventsMerged: quarter * 8,
      status: { archiveOnly: quarter * (1 + 3 + 3 + 2), matched: quarter * 3, pendingClip: 0 },
    });

    // Structure: events per pattern and no metadata conflict inside any event.
    const sizes = await db.execute<{ clips: number; events: number }>(sql`
      select clips, count(*)::int as events from (
        select count(*)::int as clips from archive_event_clips group by archive_event_id) x
      group by clips order by clips`);
    expect(sizes.rows).toEqual([
      { clips: 1, events: quarter * (3 + 5) },
      { clips: 2, events: quarter * 2 },
      { clips: 3, events: quarter },
      { clips: 5, events: quarter },
    ]);
    const conflicts = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from archive_events e
      where exists (select 1 from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
                    where l.archive_event_id = e.id and p.smart_detect_types @> array['person'])
        and exists (select 1 from archive_event_protect_events l join protect_events p on p.id = l.protect_event_id
                    where l.archive_event_id = e.id and p.smart_detect_types @> array['vehicle'])`);
    expect(conflicts.rows[0].n).toBe(0);
    const spans = await db.execute<{ max_start_span: number }>(sql`
      select coalesce(max(span), 0)::int as max_start_span from (
        select extract(epoch from max(c.start_at) - min(c.start_at)) * 1000 as span
        from archive_event_clips l join archived_clips c on c.id = l.archived_clip_id
        group by l.archive_event_id) x`);
    expect(spans.rows[0].max_start_span).toBeLessThanOrEqual(TEMPORAL_FALLBACK_START_TOLERANCE_MS);

    const state = async () =>
      (
        await db.execute(sql`
          select e.id, e.updated_at, array_agg(l.archived_clip_id || '/' || l.primary_group_id order by l.archived_clip_id) as links
          from archive_events e join archive_event_clips l on l.archive_event_id = e.id group by e.id order by e.id`)
      ).rows;
    const before = await state();

    const second = await timed("second run (unchanged)");
    expect(second.result).toMatchObject({
      relationsCreated: 0,
      archiveEventsCreated: 0,
      archiveEventsMerged: 0,
      archiveEventsSplit: 0,
      temporalLinksAdded: 0,
      temporalLinksRemoved: 0,
      eventsRecalculated: 0,
      temporalFallbackEvents: quarter * 3,
    });
    expect(await state()).toEqual(before);

    console.log(`reconcile temporal volume (${CLIPS} clips): ${timings.join(", ")}`);
    // Generous bound: catches accidental quadratic behaviour, not tuned for speed.
    expect(first.ms).toBeLessThan(CLIPS * 15);
  });
});
