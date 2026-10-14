// Loads `.env.local` and `.env` for CLI scripts (same lookup as drizzle-kit and Vitest).
// Variables already set in the environment win; `.env.local` wins over `.env`.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File does not exist.
  }
}
