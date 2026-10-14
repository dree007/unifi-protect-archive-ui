import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";
import type { Database } from "./types";

// Server-only database access (`server-only` makes importing this from a Client Component a
// build error). Importing the module does not connect: the pool is created on the first
// `getDb()` call, so `next build` neither needs DATABASE_URL nor a reachable database.

const globalForDb = globalThis as typeof globalThis & {
  unifiArchiveDb?: Database;
};

/** Validates DATABASE_URL and returns it; throws a descriptive error otherwise. */
export function readDatabaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and start the local database " +
        "(see README, “Datenbank”).",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL (expected postgresql://user:pass@host:port/db).");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must use the postgresql:// scheme, got “${url.protocol}”.`);
  }
  return value;
}

export function getDb(): Database {
  if (!globalForDb.unifiArchiveDb) {
    // Cached on globalThis so that hot reloads in `next dev` reuse the pool.
    globalForDb.unifiArchiveDb = drizzle({
      client: new Pool({ connectionString: readDatabaseUrl(process.env.DATABASE_URL) }),
      schema,
    });
  }
  return globalForDb.unifiArchiveDb;
}
