// One-shot camera sync from UniFi Protect into PostgreSQL. Read-only towards Protect.
//
//   npm run protect:sync-cameras                needs UNIFI_PROTECT_URL, UNIFI_PROTECT_API_KEY, DATABASE_URL
//   npm run protect:sync-cameras -- --verbose   also list every camera
//
// Exit codes: 0 synced, 1 failed, 2 invalid arguments.
import "./load-env.mts";

import { parseArgs } from "node:util";

import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import { syncProtectCameras } from "@/server/protect/camera-sync";
import { readProtectConfig, securityNotes } from "@/server/protect/config";
import { ProtectHttpClient } from "@/server/protect/protect-http-client";

const USAGE = "Usage: npm run protect:sync-cameras -- [--verbose]";

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

let db: Database | undefined;
let client: ProtectHttpClient | undefined;
let exitCode = 1;
try {
  const config = readProtectConfig();
  console.log("UniFi Protect camera sync\n");
  for (const note of securityNotes(config)) console.log(`Note: ${note}`);
  client = new ProtectHttpClient(config);
  db = getDb();

  const meta = await client.getMetaInfo();
  const result = await syncProtectCameras(client, db);

  console.log(`Protect:          ${config.baseUrl}`);
  console.log(`Protect version:  ${meta.applicationVersion}`);
  console.log(`Cameras received: ${result.received}\n`);
  console.log(`New:              ${result.counts.inserted}`);
  console.log(`Updated:          ${result.counts.updated}`);
  console.log(`Unchanged:        ${result.counts.unchanged}`);
  if (result.invalid.length > 0) {
    console.log(`Skipped:          ${result.invalid.length}`);
    for (const { index, reason } of result.invalid) console.error(`WARN camera #${index}: ${reason}`);
  }
  if (args.verbose) {
    console.log("");
    for (const { camera, outcome } of result.cameras) {
      const types = camera.smartDetectTypes.join(", ") || "–";
      console.log(
        `${camera.name.padEnd(20)} ${(camera.protectState ?? camera.state).padEnd(13)} ${camera.protectDeviceId}  ${outcome.padEnd(9)} ${types}`,
      );
    }
  }
  exitCode = 0;
} catch (error) {
  console.error(`Camera sync failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  client?.close();
  await db?.$client.end().catch(() => {});
}
process.exit(exitCode);
