import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** `excluded.<column>` inside `ON CONFLICT … DO UPDATE`: the value proposed for insertion. */
export function excluded(column: AnyPgColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

/**
 * A list of UUIDs as one `uuid[]` parameter (`= any(...)`), instead of drizzle's default
 * expansion into one parameter per element (which breaks for empty lists and is limited
 * to 65535 parameters).
 */
export function uuidArray(ids: readonly string[]): SQL {
  return sql`${sql.param([...ids])}::uuid[]`;
}
