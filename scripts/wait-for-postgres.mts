// Waits until a PostgreSQL server accepts connections and answers queries.
// CLI (CI, before migrations): node scripts/wait-for-postgres.mts [url]   (default: DATABASE_URL)
// Also used by the test setup, so a just-started database container does not fail the run.
import { fileURLToPath } from "node:url";

import pg from "pg";

export async function waitForPostgres(
  connectionString: string,
  { attempts = 30, delayMs = 1000 } = {},
): Promise<pg.Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // File does not exist (e.g. CI): rely on the process environment.
    }
  }
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Usage: node scripts/wait-for-postgres.mts <url>  (or set DATABASE_URL)");
    process.exit(1);
  }
  const client = await waitForPostgres(url);
  const { rows } = await client.query<{ version: string }>("select current_setting('server_version') as version");
  console.log(`PostgreSQL ${rows[0].version} is ready.`);
  await client.end();
}
