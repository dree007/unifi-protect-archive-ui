import { expect, test } from "@playwright/test";

/**
 * Browser test of the self-hosted Docker installation: the real production image, started by
 * compose.yaml, filled by the real worker (NAS scan, Protect events, reconciliation) – nothing
 * prepared in the database. Runs only with E2E_BASE_URL (playwright.config.ts), e.g. against
 * the stack kept by `KEEP=1 node tests/docker/run.mts` (docs/testing.md).
 *
 * Data of that stack: Garden 10.08. 08:00 (person, Protect) and 11:30 · Driveway + Doorbell 11.08.
 * 07:00 (one multi-camera event) · Garden 12.08. 18:45 · Garage 12.08. 20:00 (H.264) – all times
 * Europe/Berlin – plus 3,000 Garden/Driveway/Doorbell clips on 01.07. (load test).
 */

const cards = (page: import("@playwright/test").Page) => page.locator('main ol > li > a[href^="/archive/"]');

test("dashboard, archive, thumbnails, multi-camera event and video playback from the container", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const thumbnails: number[] = [];
  const videos: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/thumbnail")) thumbnails.push(response.status());
    if (response.url().includes("/video")) videos.push(response.status());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.goto("/archive?period=all");
  await expect(cards(page).first()).toBeVisible();
  const multi = cards(page).filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
  await expect(multi).toHaveCount(1);
  await expect
    .poll(() =>
      multi.locator("img[data-thumbnail]").evaluateAll((images) => images.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length),
    )
    .toBe(2);

  await page.getByRole("searchbox", { name: "Archiv durchsuchen" }).fill("Doorbell");
  await expect(page).toHaveURL(/q=Doorbell/);
  await expect(multi).toHaveCount(1);
  // Desktop opens a side panel on click; the detail page is what is tested here.
  await page.goto((await multi.getAttribute("href"))!);
  await expect(page).toHaveURL(/\/archive\/[0-9a-f-]{36}/);
  await expect(page.getByRole("tablist", { name: "Aufnahme auswählen" }).getByRole("tab")).toHaveCount(2);

  const video = page.locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/clips\/[0-9a-f-]{36}\/video$/);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 6;
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(6);
  expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();

  expect(thumbnails.length).toBeGreaterThan(0);
  expect(thumbnails.every((status) => status === 200 || status === 304)).toBe(true);
  expect(videos).toContain(206);
  expect(errors).toEqual([]);
});

test("system page shows the live worker, Protect and scan status", async ({ page }) => {
  await page.goto("/system");
  const main = page.locator("main");
  await expect(main.getByText("Aktiv").first()).toBeVisible();
  await expect(main.getByText("Verbunden").first()).toBeVisible();
  await expect(main.getByText("Erfolgreich").first()).toBeVisible();
  await expect(main).not.toContainText("/archive/");
  await expect(main).not.toContainText("/data/thumbnails");
});
