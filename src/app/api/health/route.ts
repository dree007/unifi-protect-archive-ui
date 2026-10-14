import { sql } from "drizzle-orm";

import { getDb } from "@/server/db/client";

/**
 * Health of the web server for the container health check (docker-compose.yml, docs/selfhosting.md):
 * 200 when the server answers and the database accepts a trivial query, 503 otherwise. Loads no
 * archive data, reveals no configuration; route handlers are never cached.
 */

const DATABASE_TIMEOUT_MS = 3000;

export async function GET() {
  let database: "ok" | "unavailable" = "unavailable";
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getDb().execute(sql`select 1`),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS))),
    ]);
    database = "ok";
  } catch {
    // Details go nowhere: the health check only needs the verdict.
  } finally {
    clearTimeout(timer);
  }
  return Response.json(
    { status: database === "ok" ? "ok" : "degraded", database },
    { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
