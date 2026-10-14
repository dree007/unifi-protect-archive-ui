import path from "node:path";

/** Locations of the browser-test environment (shared by e2e/prepare.mts and playwright.config.ts). */
const root = path.resolve(".cache", "e2e");

export const E2E = {
  /** Own database on the TEST_DATABASE_URL server, re-created by every preparation. */
  database: "unifi_archive_e2e",
  databaseUrl(serverUrl: string): string {
    const url = new URL(serverUrl);
    url.pathname = `/${this.database}`;
    return url.toString();
  },
  root,
  archiveRoot: path.join(root, "archive"),
  thumbnailRoot: path.join(root, "thumbnails"),
  port: Number(process.env.E2E_PORT ?? 3197),
} as const;
