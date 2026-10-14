import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import type * as schema from "./schema";

/** Drizzle database on a `pg` pool; `$client` is the pool (e.g. to close it). */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything that can run queries: the database itself or an open transaction. */
export type DbExecutor = Database | Transaction;
