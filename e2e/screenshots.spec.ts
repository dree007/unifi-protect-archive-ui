import { expect, test, type Page } from "@playwright/test";

/**
 * Screenshots for the visual review (not assertions on pixels): only with SCREENSHOTS=<label>,
 * written to .cache/e2e/screenshots/<label>/<project>-<name>.png.
 *
 *   SCREENSHOTS=after npx playwright test e2e/screenshots.spec.ts
 */
const label = process.env.SCREENSHOTS;
test.skip(!label, "set SCREENSHOTS=<label> to capture screenshots");

async function shot(page: Page, name: string, projectName: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  // Thumbnails are lazy: wait until the visible ones have decoded.
  await page
    .waitForFunction(() => [...document.images].filter((img) => img.loading !== "lazy" || img.getBoundingClientRect().top < innerHeight).every((img) => img.complete), null, { timeout: 5000 })
    .catch(() => {});
  await page.screenshot({ path: `.cache/e2e/screenshots/${label}/${projectName}-${name}.png`, fullPage });
}

const firstCard = (page: Page) => page.locator('main ol > li > a[href^="/archive/"]').first();

test("pages", async ({ page }, info) => {
  const project = info.project.name;
  const width = page.viewportSize()!.width;

  await page.goto("/");
  await shot(page, "01-dashboard", project, true);

  await page.goto("/archive");
  await expect(firstCard(page)).toBeVisible();
  await shot(page, "02-archive", project);

  await page.goto("/archive?q=Garden");
  await expect(firstCard(page)).toBeVisible();
  await shot(page, "03-search", project);

  await page.goto("/archive?period=today");
  await expect(firstCard(page)).toBeVisible();
  await shot(page, "04-period-today", project);

  if (width < 1024) {
    await page.getByRole("button", { name: /^Filter/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "05-filter-sheet", project);
    await page.keyboard.press("Escape");
  } else if (width >= 1280) {
    // Detail side panel (from 80rem)
    await page.locator('main ol > li > a[href^="/archive/"]').nth(1).click();
    await expect(page.getByRole("complementary", { name: "Ereignisdetails" }).getByRole("tablist")).toBeVisible();
    await shot(page, "05-detail-panel", project);
  }

  await page.goto("/archive?period=custom&from=2026-10-01&to=2026-10-05");
  await shot(page, "06-custom-range", project);

  await page.goto("/archive?period=today");
  const multi = page.locator('main ol > li > a[href^="/archive/"]').filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
  await page.goto((await multi.getAttribute("href"))!);
  await expect(page.locator("video")).toBeVisible();
  await page.locator("video").evaluate((video: HTMLVideoElement) => new Promise((resolve) => (video.readyState >= 1 ? resolve(null) : video.addEventListener("loadedmetadata", resolve, { once: true }))));
  await shot(page, "07-event-detail", project, true);

  // Grouping provenance: the mixed event (51 days ago, Driveway by Protect + Garage 2 by time).
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() - 51 * 86_400_000));
  await page.goto(`/archive?period=custom&from=${day}&to=${day}`);
  await expect(firstCard(page)).toBeVisible();
  await shot(page, "10-temporal-card", project);
  await page.goto((await firstCard(page).getAttribute("href"))!);
  await expect(page.locator("video")).toBeVisible();
  await shot(page, "11-temporal-detail", project, true);

  await page.goto("/cameras");
  await shot(page, "08-cameras", project, true);

  await page.goto("/system");
  await shot(page, "09-system", project, true);
});
