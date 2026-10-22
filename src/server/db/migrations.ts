import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

import { LOCK_KEYS } from "./advisory-lock";

/**
 * Applies the committed SQL migrations (drizzle/) with Drizzle's runtime migrator – the same
 * bookkeeping table as `drizzle-kit migrate` (drizzle.__drizzle_migrations), so databases
 * migrated either way are recognized. Needs no dev dependency; runs in the production image
 * (`node cli/migrate.mjs`) as well as locally (`npm run db:migrate`).
 *
 * - All pending migrations run in ONE transaction: a failing migration leaves the schema
 *   exactly as it was, never half migrated.
 * - Concurrent runs (two containers, a manual run during an update) wait for each other on an
 *   advisory lock; the second one then finds nothing to do.
 * - Nothing is ever dropped or reset here; migrations only ever go forward.
 */

export interface MigrationOutcome {
  /** Migrations in the journal of the migrations folder. */
  available: number;
  appliedBefore: number;
  appliedAfter: number;
  /** Tags of the migrations this run applied, oldest first. */
  newlyApplied: string[];
}

/** The database is ahead of this image or the migration failed; the message says which. */
export class MigrationError extends Error {
  override name = "MigrationError";
}

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

export async function readJournal(migrationsFolder: string): Promise<Journal> {
  const file = path.join(migrationsFolder, "meta", "_journal.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as Journal;
  } catch (error) {
    throw new MigrationError(`Migration journal not readable (${(error as NodeJS.ErrnoException).code ?? String(error)}): ${file}`, {
      cause: error,
    });
  }
}

/** Number of applied migrations and the newest `created_at` (0 if the database is empty). */
async function appliedState(client: Client): Promise<{ count: number; newest: number }> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
  );
  if (!rows[0].present) return { count: 0, newest: 0 };
  const result = await client.query<{ count: number; newest: string | null }>(
    "select count(*)::int as count, max(created_at)::text as newest from drizzle.__drizzle_migrations",
  );
  return { count: result.rows[0].count, newest: Number(result.rows[0].newest ?? 0) };
}

export async function runMigrations(
  databaseUrl: string,
  { migrationsFolder = "drizzle" }: { migrationsFolder?: string } = {},
): Promise<MigrationOutcome> {
  const journal = await readJournal(migrationsFolder);
  const client = new Client({ connectionString: databaseUrl, application_name: "unifi-archive-migrate" });
  await client.connect();
  try {
    // Session lock on this connection: released by the unlock below or when the connection ends.
    await client.query("select pg_advisory_lock($1)", [LOCK_KEYS.migrations]);
    try {
      const before = await appliedState(client);
      const newestKnown = Math.max(0, ...journal.entries.map((entry) => entry.when));
      if (before.newest > newestKnown) {
        // Drizzle would silently skip everything; starting an older app on a newer schema is
        // not supported (no downgrades) – say so instead of reporting "up to date".
        throw new MigrationError(
          "The database was migrated by a newer version of Protect Archive UI than this one. Downgrades are not " +
            "supported: start the newer version again, or restore a backup taken before the update.",
        );
      }
      await migrate(drizzle({ client }), { migrationsFolder });
      const after = await appliedState(client);
      const newlyApplied = journal.entries
        .filter((entry) => entry.when > before.newest && entry.when <= after.newest)
        .map((entry) => entry.tag);
      return { available: journal.entries.length, appliedBefore: before.count, appliedAfter: after.count, newlyApplied };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEYS.migrations]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}
