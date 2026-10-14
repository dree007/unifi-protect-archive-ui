// Self-hosted background worker (docs/background-worker.md): Protect event stream, periodic
// NAS scan, periodic reconciliation, heartbeat. Long-running; opens no ports. Read-only towards
// the NAS and Protect. Stops cleanly on SIGINT/SIGTERM (a second signal forces the exit).
//
//   npm run worker:run                 development (tsx)
//   npm run worker:run -- --verbose    also debug output (every Protect event, reconcile steps)
//   npm run build:cli && npm run worker:start
//                                      production: bundled, plain `node`, no dev dependencies
//
// Exit codes: 0 stopped by signal, 1 fatal error (database, lost worker lock – a restart
// policy brings it back), 2 invalid configuration or arguments, 3 another worker is active.
import "./load-env.mts";

import { parseArgs } from "node:util";

import { readWorkerConfig, WorkerConfigError } from "@/server/worker/config";
import { WorkerAlreadyRunningError } from "@/server/worker/leadership";
import { createConsoleLogger } from "@/server/worker/logger";
import { describeError, sanitizeStatusMessage } from "@/server/worker/sanitize";
import { runWorker } from "@/server/worker/worker";

const USAGE = "Usage: npm run worker:run -- [--verbose]";

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
  console.error(`${describeError(error)}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const logger = createConsoleLogger({ verbose: args.verbose });

const controller = new AbortController();
let shutdownDeadline: NodeJS.Timeout | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (controller.signal.aborted) {
      // Second signal: do not wait any longer. PostgreSQL rolls back open transactions and
      // releases the locks when the connections drop.
      logger.error("Forced exit.");
      process.exit(1);
    }
    logger.info(`${signal} received, shutting down...`);
    shutdownDeadline = setTimeout(() => {
      logger.error("Shutdown deadline reached; exiting. Incomplete atomic work will be retried after restart.");
      process.exit(1);
    }, 8_000);
    shutdownDeadline.unref();
    controller.abort();
  });
}

let exitCode = 1;
try {
  const config = readWorkerConfig();
  logger.info("Unifi Protect Archive UI background worker");
  const result = await runWorker({ config, signal: controller.signal, logger, shutdownTimeoutMs: 6_000 });
  exitCode = result.exitCode;
} catch (error) {
  if (error instanceof WorkerConfigError) {
    logger.error(error.message);
    exitCode = 2;
  } else if (error instanceof WorkerAlreadyRunningError) {
    logger.error(`${error.message} Not starting a second one.`);
    exitCode = 3;
  } else {
    // Never print DATABASE_URL credentials, PGPASSWORD or the API key.
    const secrets = [process.env.UNIFI_PROTECT_API_KEY, safePassword(process.env.DATABASE_URL), process.env.PGPASSWORD];
    logger.error(`Worker stopped: ${sanitizeStatusMessage(describeError(error), { secrets })}`);
  }
}
if (shutdownDeadline) clearTimeout(shutdownDeadline);
process.exit(exitCode);

function safePassword(url: string | undefined): string | undefined {
  try {
    return url ? decodeURIComponent(new URL(url).password) || undefined : undefined;
  } catch {
    return undefined;
  }
}
