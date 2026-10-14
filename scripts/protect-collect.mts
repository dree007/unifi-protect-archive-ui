// Long-running UniFi Protect event collector (WebSocket → protect_events). Read-only towards
// Protect. Runs until Ctrl+C / SIGTERM; suitable as a separate process from the app image.
//
//   npm run protect:collect                needs UNIFI_PROTECT_URL, UNIFI_PROTECT_API_KEY, DATABASE_URL
//   npm run protect:collect -- --verbose   also print every received event
//
// Exit codes: 0 stopped by signal, 1 fatal error (configuration, rejected API key, database),
// 2 invalid arguments, 3 another collector is running (the background worker or a second
// protect:collect: they would subscribe to the same events twice).
import "./load-env.mts";

import { parseArgs } from "node:util";

import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import { readProtectConfig, securityNotes } from "@/server/protect/config";
import type { ProtectLogger } from "@/server/protect/logger";
import { runProtectCollector } from "@/server/protect/protect-collector";
import { ProtectHttpClient } from "@/server/protect/protect-http-client";

const USAGE = "Usage: npm run protect:collect -- [--verbose]";

let args;
try {
  args = parseArgs({
    options: {
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const time = () => new Date().toISOString();
const logger: ProtectLogger = {
  info: (message) => console.log(`${time()}  ${message}`),
  warn: (message) => console.warn(`${time()}  WARN  ${message}`),
  error: (message) => console.error(`${time()}  ERROR ${message}`),
  debug: (message) => {
    if (args.verbose) console.log(`${time()}  ${message}`);
  },
};

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (controller.signal.aborted) {
      // Second signal: do not wait any longer.
      console.error("Forced exit.");
      process.exit(1);
    }
    logger.info(`${signal} received, shutting down...`);
    controller.abort();
  });
}

let db: Database | undefined;
let client: ProtectHttpClient | undefined;
let releaseLock: (() => Promise<void>) | null = null;
let exitCode = 1;
try {
  const config = readProtectConfig();
  console.log("UniFi Protect collector\n");
  console.log(`Protect: ${config.baseUrl}`);
  for (const note of securityNotes(config)) console.log(`Note: ${note}`);
  console.log("");
  db = getDb();
  releaseLock = await tryAcquireAdvisoryLock(db, LOCK_KEYS.protectCollector);
  if (!releaseLock) {
    exitCode = 3;
    throw new Error(
      "Another Protect collector is already running (the background worker, npm run worker:run, or a second " +
        "protect:collect). Not starting a second one.",
    );
  }
  client = new ProtectHttpClient(config);
  await runProtectCollector({ config, client, db, logger, signal: controller.signal });
  exitCode = 0;
} catch (error) {
  logger.error(`Collector stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  client?.close();
  await releaseLock?.().catch(() => {});
  await db?.$client.end().catch(() => {});
}
process.exit(exitCode);
