import { defineConfig, devices } from "@playwright/test";

import { E2E } from "./e2e/environment.mts";

// TEST_DATABASE_URL may come from local env files (like Vitest and drizzle-kit).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File does not exist.
  }
}

/**
 * Browser tests against a production build (`next build` + standalone server) with the
 * deterministic environment of e2e/prepare.mts (own database, temporary archive, synthetic
 * videos). Run with `npm run test:e2e`; see docs/testing.md. The browser can be remote:
 * PW_TEST_CONNECT_WS_ENDPOINT (e.g. the `playwright` compose service) is picked up automatically.
 */
const baseURL = `http://127.0.0.1:${E2E.port}`;
/**
 * E2E_BASE_URL: test an already running installation instead (e.g. the Docker stack of
 * tests/docker/run.mts with KEEP=1, see docs/testing.md); then no server is started and only
 * e2e/docker.spec.ts applies.
 */
const externalBaseURL = process.env.E2E_BASE_URL?.trim() || undefined;

export default defineConfig({
  testDir: "e2e",
  outputDir: externalBaseURL ? ".cache/docker-e2e-results" : ".cache/e2e/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  ...(externalBaseURL ? { testMatch: /(docker|access-boundary)\.spec/ } : { testIgnore: /docker\.spec/ }),
  use: {
    baseURL: externalBaseURL ?? baseURL,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
    // Further widths only for the screenshot review (e2e/screenshots.spec.ts).
    { name: "small", testMatch: /screenshots/, use: { ...devices["Pixel 7"], viewport: { width: 320, height: 640 } } },
    { name: "tablet", testMatch: /screenshots/, use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: "wide", testMatch: /screenshots/, use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: "npm run build && node .next/standalone/server.js",
        url: `${baseURL}/archive`,
        reuseExistingServer: false,
        timeout: 300_000,
        stdout: "ignore",
        stderr: "pipe",
        // Explicit values win over .env.local: never the app database or the real archive.
        env: {
          PORT: String(E2E.port),
          HOSTNAME: "127.0.0.1",
          DATABASE_URL: E2E.databaseUrl(process.env.TEST_DATABASE_URL ?? "postgresql://localhost/none"),
          ARCHIVE_ROOT: E2E.archiveRoot,
          THUMBNAIL_CACHE_ROOT: E2E.thumbnailRoot,
          FFMPEG_PATH: "ffmpeg",
          APP_TIME_ZONE: "Europe/Berlin",
          APP_SOURCE_URL: "https://source.example.invalid/releases/1.0.0",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});
