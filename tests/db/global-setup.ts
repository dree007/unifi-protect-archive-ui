import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

import { waitForPostgres } from "../../scripts/wait-for-postgres.mts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Shared, migrated database for most tests. */
    databaseUrl: string;
    /** Server URL (any database) for creating isolated databases. */
    serverUrl: string;
    /** Migrated template from which isolated databases are cloned. */
    templateDatabase: string;
    /** Prefix of every database created by this run (dropped at the end). */
    databasePrefix: string;
  }
}

/**
 * Creates uniquely named databases on the server given by TEST_DATABASE_URL: a migrated
 * template, and from it the shared test database. Tests that need a database of their own
 * clone the template (tests/db/helpers.ts). Everything with this run's prefix is dropped at
 * the end; existing databases are never touched.
 */
export default async function setup(project: TestProject) {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (!serverUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a PostgreSQL 18 server where the user may " +
        "create databases, e.g. postgresql://unifi_archive:unifi_archive@localhost:5432/unifi_archive " +
        "(see .env.example).",
    );
  }

  const admin = await waitForPostgres(serverUrl);
  const { rows } = await admin.query<{ major: number }>(
    "select current_setting('server_version_num')::int / 10000 as major",
  );
  if (rows[0].major < 18) {
    await admin.end();
    // The schema relies on PostgreSQL 18 (uuidv7(), RETURNING old/new).
    throw new Error(`PostgreSQL 18 or newer required, server is ${rows[0].major}.`);
  }

  const prefix = `unifi_archive_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const template = `${prefix}_template`;
  const shared = `${prefix}_shared`;
  const urlFor = (name: string) => {
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };

  await admin.query(`create database "${template}"`);
  const pool = new Pool({ connectionString: urlFor(template) });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "drizzle" });
  } finally {
    // The template must have no open connections to be cloned.
    await pool.end();
  }
  await admin.query(`create database "${shared}" template "${template}" strategy file_copy`);

  project.provide("databaseUrl", urlFor(shared));
  project.provide("serverUrl", serverUrl);
  project.provide("templateDatabase", template);
  project.provide("databasePrefix", prefix);

  return async () => {
    const { rows: databases } = await admin.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [prefix],
    );
    for (const { datname } of databases) {
      await admin.query(`drop database if exists "${datname}" with (force)`);
    }
    await admin.end();
  };
}
