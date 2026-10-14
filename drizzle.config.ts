import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read `.env*` files itself. Pick up local files if present; variables
// already set in the environment (e.g. in CI) win, and `.env.local` wins over `.env`.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File does not exist.
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed by commands that connect (migrate, studio); `generate` works without it.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
