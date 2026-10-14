import { sql } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";

import { getDb, readDatabaseUrl } from "@/server/db/client";

describe("database client", () => {
  it("requires a postgresql:// DATABASE_URL", () => {
    expect(() => readDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => readDatabaseUrl("   ")).toThrow(/DATABASE_URL is not set/);
    expect(() => readDatabaseUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => readDatabaseUrl("mysql://u:p@localhost/db")).toThrow(/postgresql:\/\//);
    expect(readDatabaseUrl("postgresql://u:p@localhost:5432/db")).toBe(
      "postgresql://u:p@localhost:5432/db",
    );
  });

  it("connects lazily on first use and reuses the pool", async () => {
    process.env.DATABASE_URL = inject("databaseUrl");
    const db = getDb();
    expect(getDb()).toBe(db);
    const { rows } = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(rows[0].ok).toBe(1);
    await db.$client.end();
  });
});
