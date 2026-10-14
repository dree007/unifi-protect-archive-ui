import type { Database } from "./types";

/**
 * Fixed keys of the PostgreSQL advisory locks. All are taken with `pg_try_advisory_lock`
 * (never waiting), so they cannot deadlock each other.
 */
export const LOCK_KEYS = {
  archiveScan: 4_711_202_603,
  reconciliation: 4_711_202_604,
  /** One background worker per database, held for the worker's lifetime (worker/leadership.ts). */
  worker: 4_711_202_605,
  /** One Protect event collector per database: the worker's or `npm run protect:collect`. */
  protectCollector: 4_711_202_606,
  /** Serializes migration runs (db/migrations.ts); the only key that is waited for. */
  migrations: 4_711_202_607,
} as const;

/**
 * Takes a session-level advisory lock on a dedicated connection. Returns a release function,
 * or `null` if another session holds the lock. The lock is also released automatically if
 * the process dies (the connection closes).
 */
export async function tryAcquireAdvisoryLock(db: Database, key: number): Promise<(() => Promise<void>) | null> {
  const client = await db.$client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key]);
    if (!rows[0].locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query("select pg_advisory_unlock($1)", [key]);
    } finally {
      client.release();
    }
  };
}
