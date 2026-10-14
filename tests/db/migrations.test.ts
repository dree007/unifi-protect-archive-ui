import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";

import { connectTestDb, createIsolatedDb } from "./helpers";

const { db, pool } = connectTestDb();

interface Journal {
  entries: { idx: number; tag: string }[];
}

const readJournal = async (): Promise<Journal> =>
  JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;

/** Names from a catalog query, sorted by code point (independent of the server collation). */
async function names(sqlText: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(sqlText);
  return rows.map((row) => row.name).toSorted();
}

describe("migrations", () => {
  // The global setup migrated a freshly created, empty database (the template of this one).
  it("create all tables on an empty database", async () => {
    expect(
      await names(
        `select table_name as name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'`,
      ),
    ).toEqual([
      "archive_event_clips",
      "archive_event_protect_events",
      "archive_events",
      "archive_scan_runs",
      "archived_clips",
      "background_component_status",
      "cameras",
      "protect_events",
    ]);
  });

  it("record every migration of the journal and are a no-op when applied again", async () => {
    const journal = await readJournal();
    const count = async () =>
      (await pool.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0].n;

    expect(await count()).toBe(journal.entries.length);
    await migrate(db, { migrationsFolder: "drizzle" });
    expect(await count()).toBe(journal.entries.length);
  });

  it("upgrade a database with data from 0000_init to the current schema", async () => {
    const journal = await readJournal();
    const [init] = journal.entries;
    expect(init.tag).toBe("0000_init");

    // A migrations folder that contains only the first migration.
    const folder = await mkdtemp(path.join(tmpdir(), "unifi-archive-migrations-"));
    afterAll(() => rm(folder, { recursive: true, force: true }));
    await mkdir(path.join(folder, "meta"));
    await copyFile(`drizzle/${init.tag}.sql`, path.join(folder, `${init.tag}.sql`));
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [init] }));

    const isolated = await createIsolatedDb({ empty: true });
    await migrate(isolated.db, { migrationsFolder: folder });
    await isolated.pool.query(`
      insert into cameras (protect_device_id, name, state) values ('660000000000000000000002', 'Driveway', 'online');
      insert into archived_clips (camera_id, camera_name, start_at, end_at, duration_ms, file_path, file_name, day_directory)
        select id, 'Driveway', '2026-03-29T11:01:05Z', '2026-03-29T11:02:18Z', 73000,
               '2026-03-29/Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4',
               'Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4', '2026-03-29'
        from cameras;
      insert into archive_events (start_at, end_at, metadata_status) values ('2026-03-29T11:01:05Z', '2026-03-29T11:02:18Z', 'archiveOnly');
      insert into archive_event_clips select e.id, c.id from archive_events e, archived_clips c;
    `);

    await migrate(isolated.db, { migrationsFolder: "drizzle" });

    const { rows } = await isolated.pool.query<{
      clips: number;
      links: number;
      own_group: number;
      runs: number;
      status_rows: number;
      migrations: number;
    }>(`
      select (select count(*)::int from archived_clips) as clips,
             (select count(*)::int from archive_event_clips) as links,
             -- 0003: every existing event is exactly one primary group, its own
             (select count(*)::int from archive_event_clips where primary_group_id = archive_event_id) as own_group,
             (select count(*)::int from archive_scan_runs) as runs,
             -- 0004: the worker status starts empty ("never started"), whatever data exists
             (select count(*)::int from background_component_status) as status_rows,
             (select count(*)::int from drizzle.__drizzle_migrations) as migrations`);
    expect(rows[0]).toEqual({ clips: 1, links: 1, own_group: 1, runs: 0, status_rows: 0, migrations: journal.entries.length });
  });

  it("store all points in time as timestamptz", async () => {
    const { rows } = await pool.query<{ column: string; data_type: string }>(
      `select table_name || '.' || column_name as column, data_type
       from information_schema.columns
       where table_schema = 'public' and (column_name like '%\\_at' or column_name like '%\\_at\\_%')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, row.column).toBe("timestamp with time zone");
    }
  });

  it("define the expected unique constraints and unique indexes", async () => {
    expect(
      await names(
        `select conname as name from pg_constraint
         where contype = 'u' and connamespace = 'public'::regnamespace`,
      ),
    ).toEqual([
      "archived_clips_file_path_unique",
      "cameras_protect_device_id_unique",
      "protect_events_protect_event_id_unique",
    ]);
    expect(
      await names(
        `select indexname as name from pg_indexes
         where schemaname = 'public' and indexdef like 'CREATE UNIQUE INDEX%' and indexname like '%\\_idx'`,
      ),
    ).toEqual(["archive_scan_runs_single_running_idx"]);
  });

  it("define the planned indexes", async () => {
    expect(
      await names(`select indexname as name from pg_indexes where schemaname = 'public' and indexname like '%\\_idx'`),
    ).toEqual([
      "archive_event_clips_archived_clip_id_idx",
      "archive_event_protect_events_protect_event_id_idx",
      "archive_events_metadata_status_start_at_idx",
      "archive_events_start_at_idx",
      "archive_scan_runs_single_running_idx",
      "archive_scan_runs_status_started_at_idx",
      "archived_clips_camera_id_start_at_idx",
      "archived_clips_start_at_idx",
      "protect_events_camera_id_start_at_idx",
      "protect_events_protect_device_id_idx",
      "protect_events_start_at_idx",
    ]);
  });

  it("use SET NULL for camera references and CASCADE only on join tables", async () => {
    const { rows } = await pool.query<{ table: string; column: string; on_delete: string }>(
      `select c.conrelid::regclass::text as table, a.attname as column,
              case c.confdeltype when 'n' then 'set null' when 'c' then 'cascade'
                                 when 'a' then 'no action' when 'r' then 'restrict' end as on_delete
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
    );
    const sorted = rows.toSorted((a, b) => (`${a.table}.${a.column}` < `${b.table}.${b.column}` ? -1 : 1));
    expect(sorted).toEqual([
      { table: "archive_event_clips", column: "archive_event_id", on_delete: "cascade" },
      { table: "archive_event_clips", column: "archived_clip_id", on_delete: "cascade" },
      { table: "archive_event_protect_events", column: "archive_event_id", on_delete: "cascade" },
      { table: "archive_event_protect_events", column: "protect_event_id", on_delete: "cascade" },
      { table: "archived_clips", column: "camera_id", on_delete: "set null" },
      { table: "protect_events", column: "camera_id", on_delete: "set null" },
    ]);
  });
});
