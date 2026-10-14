import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// TEST_DATABASE_URL may come from local env files, like DATABASE_URL for drizzle-kit.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File does not exist (e.g. CI): rely on the process environment.
  }
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `server-only` throws outside React Server environments; tests run on the server.
    alias: {
      "server-only": fileURLToPath(new URL("node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        // Pure logic and file system (temporary directories); no database needed.
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        // Against a real PostgreSQL 18: a fresh, migrated database per run (see README).
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          globalSetup: ["tests/db/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
