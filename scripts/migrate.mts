// Applies pending database migrations (src/server/db/migrations.ts), then exits.
//
//   npm run db:migrate                 locally (tsx)
//   node cli/migrate.mjs               in the production image – the one-shot `migrate` service
//                                      of compose.yaml runs it before web and worker start
//
// Waits up to ~60 s for the database. Never resets or drops anything.
// Exit codes: 0 schema current, 1 migration failed or database unreachable (nothing half
// applied), 2 invalid configuration.
import "./load-env.mts";

import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import { readDatabaseUrl } from "@/server/db/client";
import { MigrationError, runMigrations } from "@/server/db/migrations";
import { describeError, sanitizeStatusMessage } from "@/server/worker/sanitize";

const ATTEMPTS = 30;
const DELAY_MS = 2000;

let databaseUrl: string;
try {
  databaseUrl = readDatabaseUrl(process.env.DATABASE_URL);
} catch (error) {
  console.error(describeError(error));
  process.exit(2);
}

// Never print DATABASE_URL credentials or PGPASSWORD (compose.yaml passes the password that way).
const secrets = [process.env.PGPASSWORD, passwordOf(databaseUrl)];
const clean = (error: unknown) => sanitizeStatusMessage(describeError(error), { secrets });

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch (error) {
      // Wrong password, unknown database or user: waiting does not help.
      const code = (error as { code?: string }).code;
      if (attempt >= ATTEMPTS || code === "28P01" || code === "28000" || code === "3D000") throw error;
      if (attempt === 1) console.log("Waiting for the database...");
      await sleep(DELAY_MS);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

try {
  await waitForDatabase();
} catch (error) {
  console.error(`Database not reachable: ${clean(error)}`);
  process.exit(1);
}

try {
  const outcome = await runMigrations(databaseUrl, { migrationsFolder: process.env.MIGRATIONS_FOLDER?.trim() || "drizzle" });
  if (outcome.newlyApplied.length > 0) {
    console.log(`Applied ${outcome.newlyApplied.length} migration(s): ${outcome.newlyApplied.join(", ")}.`);
  }
  console.log(`Database schema is up to date (${outcome.appliedAfter} of ${outcome.available} migrations applied).`);
  process.exit(0);
} catch (error) {
  const reason = error instanceof MigrationError ? error.message : clean(error);
  console.error(`Migration failed – no pending migrations were applied; web and worker must not start: ${reason}`);
  process.exit(1);
}

function passwordOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
