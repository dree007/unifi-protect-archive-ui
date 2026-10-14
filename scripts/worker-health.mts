// Health check of the background worker (Docker HEALTHCHECK of the `worker` service):
//
//   node cli/worker-health.mjs         in the production image
//
// Healthy = the persisted worker row is `starting`/`running` and its heartbeat is younger than
// WORKER_HEARTBEAT_STALE_SECONDS (database clock). Protect is reported, but never makes the
// worker unhealthy: Protect being disabled or temporarily unreachable does not stop NAS scans
// and reconciliation. One small query, short timeouts; prints one line without secrets.
//
// Exit codes: 0 healthy, 1 unhealthy (stale, stopped, no worker row, database unreachable).
import "./load-env.mts";

import pg from "pg";

import { readHeartbeatStaleMs } from "@/server/worker/config";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.log("unhealthy: DATABASE_URL is not set");
  process.exit(1);
}

const staleMs = readHeartbeatStaleMs();
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  application_name: "unifi-archive-healthcheck",
});

let exitCode = 1;
try {
  await client.connect();
  const { rows } = await client.query<{ component: string; state: string; age_ms: string | null; same_instance: boolean }>(`
    select s.component, s.state,
           (extract(epoch from now() - s.heartbeat_at) * 1000)::bigint::text as age_ms,
           s.instance_id = w.instance_id as same_instance
    from background_component_status s
    left join background_component_status w on w.component = 'worker'`);
  const byComponent = new Map(rows.map((row) => [row.component, row]));
  const worker = byComponent.get("worker");
  if (!worker) {
    console.log("unhealthy: the worker has not registered yet");
  } else {
    const ageMs = worker.age_ms === null ? Number.POSITIVE_INFINITY : Number(worker.age_ms);
    const ageText = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)} s` : "never";
    const extras = ["protect", "archiveScan", "reconciliation"]
      .map((name) => byComponent.get(name))
      .filter((row) => row?.same_instance)
      .map((row) => `${row!.component}: ${row!.state}`);
    const summary = `worker ${worker.state}, heartbeat ${ageText} ago${extras.length ? `; ${extras.join(", ")}` : ""}`;
    if ((worker.state === "starting" || worker.state === "running") && ageMs <= staleMs) {
      console.log(`healthy: ${summary}`);
      exitCode = 0;
    } else {
      console.log(`unhealthy: ${summary} (stale after ${staleMs / 1000} s)`);
    }
  }
} catch (error) {
  // pg messages contain no password; the code is enough to tell what is wrong.
  const code = (error as { code?: string }).code;
  console.log(`unhealthy: database query failed${code ? ` (${code})` : ""}: ${(error as Error).message}`);
} finally {
  await client.end().catch(() => {});
}
process.exit(exitCode);
