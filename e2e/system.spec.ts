import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

import { E2E } from "./environment.mts";

/**
 * System page with real operating states: each scenario writes the worker status rows into the
 * e2e database (as the worker would), then checks the page at 1440 px and 390 px – texts,
 * independence of the components, no internal paths, no horizontal overflow, focus, touch
 * targets, no console errors. Screenshots for the visual review land in
 * .cache/e2e/screenshots/system/<project>-<scenario>.png.
 */

const INSTANCE = "0199c000-0000-7000-8000-00000000e2e0";
const OLD_INSTANCE = "0199c000-0000-7000-8000-00000000e2e1";

interface Row {
  component: "worker" | "protect" | "archiveScan" | "reconciliation";
  state: string;
  /** Seconds since the heartbeat (worker row). */
  heartbeatAgo?: number;
  instance?: string;
  error?: string;
  details?: Record<string, unknown>;
  succeededAgo?: number;
  nextIn?: number;
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: E2E.databaseUrl(process.env.TEST_DATABASE_URL ?? "postgresql://localhost/none") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setStatus(rows: Row[]): Promise<void> {
  await withDb(async (client) => {
    await client.query("delete from background_component_status");
    for (const row of rows) {
      await client.query(
        `insert into background_component_status
           (component, instance_id, state, heartbeat_at, instance_started_at, last_started_at, last_succeeded_at,
            last_failed_at, last_error_message, next_run_at, details)
         values ($1, $2, $3,
                 case when $4::int is null then null else now() - make_interval(secs => $4::int) end,
                 now() - interval '2 hours', now() - interval '3 minutes',
                 case when $7::int is null then null else now() - make_interval(secs => $7::int) end,
                 case when $5::text is null then null else now() - interval '1 minute' end,
                 $5, case when $8::int is null then null else now() + make_interval(secs => $8::int) end, $6)`,
        [row.component, row.instance ?? INSTANCE, row.state, row.heartbeatAgo ?? null, row.error ?? null, row.details ?? null, row.succeededAgo ?? null, row.nextIn ?? null],
      );
    }
  });
}

const RECONCILED = {
  durationMs: 4200,
  clipsTotal: 20000,
  archiveEventsCreated: 12,
  archiveEventsMerged: 2,
  archiveEventsSplit: 1,
  temporalFallbackEvents: 640,
  multiCameraEvents: 210,
};

const card = (page: Page, title: string) => page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

async function open(page: Page, scenario: string, project: string) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/system");
  await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  // No horizontal overflow at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // The browser never sees the archive's absolute path.
  expect(await page.content()).not.toContain(E2E.archiveRoot);
  await page.screenshot({ path: `.cache/e2e/screenshots/system/${project}-${scenario}.png`, fullPage: true });
  return errors;
}

test.describe.configure({ mode: "serial" });
test.afterAll(() => setStatus([]));

test("fresh installation: no operating status, never 'all good'", async ({ page }, info) => {
  await setStatus([]);
  const errors = await open(page, "01-not-started", info.project.name);
  await expect(card(page, "Hintergrunddienst")).toContainText("Noch nicht gestartet");
  await expect(card(page, "Hintergrunddienst")).toContainText("Hintergrunddienst noch nicht gestartet");
  await expect(card(page, "UniFi Protect")).toContainText("Kein Status");
  await expect(card(page, "Abgleich")).toContainText("Kein Status");
  await expect(page.getByText("Aktiv", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Verbunden", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("worker active, Protect connected, NAS and reconciliation successful", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "running", heartbeatAgo: 12 },
    { component: "protect", state: "connected", details: { cameraCount: 6 }, succeededAgo: 3600 },
    { component: "archiveScan", state: "success", succeededAgo: 300, nextIn: 600 },
    { component: "reconciliation", state: "success", succeededAgo: 60, nextIn: 240, details: RECONCILED },
  ]);
  const errors = await open(page, "02-active", info.project.name);
  await expect(card(page, "Hintergrunddienst")).toContainText("Aktiv");
  await expect(card(page, "Hintergrunddienst")).toContainText("vor 12 Sekunden");
  await expect(card(page, "UniFi Protect")).toContainText("Verbunden");
  await expect(card(page, "NAS-Indexer")).toContainText("Erfolgreich");
  await expect(card(page, "NAS-Indexer")).toContainText("in 10 Minuten");
  const reconcile = card(page, "Abgleich");
  await expect(reconcile).toContainText("Erfolgreich");
  await expect(reconcile).toContainText("4 Sek.");
  await expect(reconcile.getByText("Zeitbasiert")).toBeVisible();
  await expect(reconcile).toContainText("640");

  // Refresh control: reachable by keyboard with a visible focus ring, large enough to tap.
  const refresh = page.getByRole("button", { name: "Jetzt aktualisieren" });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  const ring = await refresh.evaluate((element) => getComputedStyle(element).boxShadow + getComputedStyle(element).outlineStyle);
  expect(ring).not.toBe("nonenone");
  expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(40);

  // A status change shows up after "Jetzt aktualisieren" (no full reload).
  await setStatus([{ component: "worker", state: "stopped", heartbeatAgo: 30 }]);
  await refresh.click();
  await expect(card(page, "Hintergrunddienst")).toContainText("Gestoppt");
  expect(errors).toEqual([]);
});

test("stale heartbeat: 'running' in the database is not trusted", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "running", heartbeatAgo: 600 },
    { component: "protect", state: "connected" },
    { component: "archiveScan", state: "running" },
    { component: "reconciliation", state: "success", details: RECONCILED, succeededAgo: 900 },
  ]);
  const errors = await open(page, "03-stale", info.project.name);
  await expect(card(page, "Hintergrunddienst")).toContainText("Keine aktuelle Verbindung");
  await expect(card(page, "Hintergrunddienst")).toContainText("vor 10 Minuten");
  await expect(card(page, "UniFi Protect")).toContainText("Status unbekannt");
  await expect(card(page, "UniFi Protect")).not.toContainText("Verbunden");
  await expect(card(page, "NAS-Indexer")).toContainText("Unterbrochen");
  expect(errors).toEqual([]);
});

test("worker offline (stopped) and Protect deliberately disabled", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "stopped", heartbeatAgo: 7200 },
    { component: "protect", state: "disabled", details: { disabledReason: "switchedOff" } },
    { component: "archiveScan", state: "success", succeededAgo: 7300 },
    { component: "reconciliation", state: "success", succeededAgo: 7250, details: RECONCILED },
  ]);
  const errors = await open(page, "04-offline-protect-disabled", info.project.name);
  await expect(card(page, "Hintergrunddienst")).toContainText("Gestoppt");
  const protect = card(page, "UniFi Protect");
  await expect(protect).toContainText("Deaktiviert");
  await expect(protect).toContainText("PROTECT_COLLECTOR_ENABLED=false");
  await expect(protect).not.toContainText("Fehler");
  await expect(protect).not.toContainText("Verbindungsfehler");
  expect(errors).toEqual([]);
});

test("Protect reconnecting while everything else is fine", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "running", heartbeatAgo: 5 },
    { component: "protect", state: "reconnecting", error: "Protect not available: Cannot reach Protect for /proxy/protect/integration/v1/meta/info: connect ECONNREFUSED 192.168.0.1:443 (ECONNREFUSED).", succeededAgo: 1800 },
    { component: "archiveScan", state: "success", succeededAgo: 120, nextIn: 780 },
    { component: "reconciliation", state: "success", succeededAgo: 30, nextIn: 270, details: RECONCILED },
  ]);
  const errors = await open(page, "05-protect-reconnecting", info.project.name);
  await expect(card(page, "Hintergrunddienst")).toContainText("Aktiv");
  await expect(card(page, "UniFi Protect")).toContainText("Verbindung wird wiederhergestellt");
  await expect(card(page, "UniFi Protect")).toContainText("ECONNREFUSED");
  await expect(card(page, "NAS-Indexer")).toContainText("Erfolgreich");
  await expect(card(page, "Abgleich")).toContainText("Erfolgreich");
  expect(errors).toEqual([]);
});

test("NAS scan and reconciliation failed: soft error notes, sanitized messages", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "running", heartbeatAgo: 20 },
    { component: "protect", state: "authenticationError", error: "Protect rejected the API key (HTTP 401 for /proxy/protect/integration/v1/meta/info). Check UNIFI_PROTECT_API_KEY." },
    { component: "archiveScan", state: "error", error: `EACCES: permission denied, scandir '${E2E.archiveRoot}/UniFi-Protect_2026-10-09'` },
    { component: "reconciliation", state: "error", error: "deadlock detected (SQLSTATE 40P01)", succeededAgo: 3600, details: RECONCILED },
  ]);
  const errors = await open(page, "06-failures", info.project.name);
  await expect(card(page, "UniFi Protect")).toContainText("API-Key abgelehnt");
  await expect(card(page, "NAS-Indexer")).toContainText("Fehlgeschlagen");
  await expect(card(page, "NAS-Indexer")).toContainText("EACCES");
  await expect(card(page, "Abgleich")).toContainText("Fehlgeschlagen");
  await expect(card(page, "Abgleich")).toContainText("SQLSTATE 40P01");
  await expect(card(page, "Hintergrunddienst")).toContainText("Aktiv");
  await expect(page.locator("main")).not.toContainText(E2E.archiveRoot);
  await expect(page.locator("main")).not.toContainText("UniFi-Protect_2026-10-09");
  expect(errors).toEqual([]);
});

test("rows of an old worker instance are not shown as current", async ({ page }, info) => {
  await setStatus([
    { component: "worker", state: "running", heartbeatAgo: 3 },
    { component: "protect", state: "connected", instance: OLD_INSTANCE },
    { component: "archiveScan", state: "running", instance: OLD_INSTANCE },
  ]);
  const errors = await open(page, "07-old-instance", info.project.name);
  await expect(card(page, "UniFi Protect")).toContainText("Status unbekannt");
  await expect(card(page, "NAS-Indexer")).toContainText("Unterbrochen");
  expect(errors).toEqual([]);
});
