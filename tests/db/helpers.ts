import { randomBytes, randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, expect, inject } from "vitest";

import { findPgError, PgErrorCode } from "@/server/db/errors";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import type { ArchivedClipInput } from "@/server/repositories/archived-clips";

/** Connects to the migrated test database; the pool is closed after the test file. */
export function connectTestDb(): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());
  return { db: drizzle({ client: pool, schema }), pool };
}

/**
 * Creates a database of its own for one test (dropped after the test file): a clone of the
 * migrated template, or `empty` without any tables (for migration tests). Needed where a
 * test depends on the whole table contents, e.g. missing-clip counts.
 */
export async function createIsolatedDb({ empty = false } = {}): Promise<{ db: Database; pool: Pool; url: string }> {
  const name = `${inject("databasePrefix")}_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: inject("serverUrl") });
  await admin.connect();
  try {
    await admin.query(
      empty ? `create database "${name}"` : `create database "${name}" template "${inject("templateDatabase")}" strategy file_copy`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(inject("serverUrl"));
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  // The global teardown drops the database itself.
  afterAll(() => pool.end());
  return { db: drizzle({ client: pool, schema }), pool, url: url.toString() };
}

export { PgErrorCode };

/** Asserts that PostgreSQL itself rejected the statement with the given SQLSTATE (and constraint). */
export async function expectDbError(
  query: PromiseLike<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected PostgreSQL to reject the statement").toBeDefined();
  const pgError = findPgError(error);
  expect(pgError, `expected a PostgreSQL error, got: ${String(error)}`).toBeDefined();
  expect(pgError?.code).toBe(code);
  if (constraint) expect(pgError?.constraint).toBe(constraint);
}

/**
 * Test files share one database and run in parallel, so every external ID or path is made
 * unique per call. Protect device IDs are 24 hex characters, like the real ones.
 */
export function uniqueProtectId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

/** A clip as the NAS indexer would store it, with a unique path. */
export function clipInput(overrides: Partial<ArchivedClipInput> = {}): ArchivedClipInput {
  const startAt = overrides.startAt ?? new Date("2026-03-29T13:01:05+02:00");
  const endAt = overrides.endAt ?? new Date(startAt.getTime() + 73_000);
  const cameraName = overrides.cameraName ?? "Driveway";
  const fileName = `${cameraName} 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2 ${randomUUID()}.mp4`;
  return {
    cameraName,
    startAt,
    endAt,
    durationMs: endAt.getTime() - startAt.getTime(),
    filePath: `2026-03-29/${fileName}`,
    fileName,
    fileSizeBytes: 91_900_000,
    dayDirectory: "2026-03-29",
    ...overrides,
  };
}
