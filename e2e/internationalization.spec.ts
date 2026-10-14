import { expect, test, type Page } from "@playwright/test";

const cards = (page: Page) => page.locator('main ol > li > a[href^="/archive/"]');
const eventLinks = (page: Page) => cards(page).evaluateAll((items) => items.map((item) => item.getAttribute("href")));

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydration|react|translation/i.test(message.text())) errors.push(message.text()); });
  return errors;
}

test("plate search aliases find the same events through EN to DE and DE to EN switches", async ({ page }) => {
  const errors = browserErrors(page);
  const eventPaths = () => cards(page).evaluateAll((items) => items.map((item) => new URL((item as HTMLAnchorElement).href).pathname));
  await page.goto("/archive?period=7d");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("searchbox", { name: "Search archive" }).fill("Licence plate");
  await expect(page).toHaveURL(/q=Licence\+plate/);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Licence plate");
  const matches = await eventPaths(), englishUrl = page.url();

  await page.getByRole("button", { name: "Deutsch", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  expect(page.url()).toBe(englishUrl);
  await expect(page.getByRole("searchbox", { name: "Archiv durchsuchen" })).toHaveValue("Licence plate");
  expect(await eventPaths()).toEqual(matches);
  await expect(cards(page).first()).toContainText("Kennzeichen");

  await page.getByRole("searchbox", { name: "Archiv durchsuchen" }).fill("Kennzeichen");
  await expect(page).toHaveURL(/q=Kennzeichen/);
  await expect(cards(page)).toHaveCount(1);
  expect(await eventPaths()).toEqual(matches);
  const germanUrl = page.url();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(page.url()).toBe(germanUrl);
  await expect(page.getByRole("searchbox", { name: "Search archive" })).toHaveValue("Kennzeichen");
  expect(await eventPaths()).toEqual(matches);
  for (const alias of ["License plate", "licensePlate"]) {
    await page.getByRole("searchbox", { name: "Search archive" }).fill(alias);
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(alias);
    await expect(cards(page)).toHaveCount(1);
    expect(await eventPaths()).toEqual(matches);
  }
  expect(new URL(page.url()).searchParams.get("period")).toBe("7d");
  expect(errors).toEqual([]);
});

for (const preference of ["en-US", "fr-FR", "de-AT"]) {
  test(`first SSR, metadata and client locale agree for ${preference}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale: preference });
    try {
      const page = await context.newPage();
      const errors = browserErrors(page);
      const response = await page.goto("/");
      const locale = preference.startsWith("de") ? "de" : "en";
      expect(await response!.text()).toContain(`lang="${locale}"`);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("button", { name: locale === "de" ? "Deutsch" : "English", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", locale === "de" ? /Archivierte/ : /Browse, search/);
      for (const [route, title] of [["/archive", locale === "de" ? "Archiv" : "Archive"], ["/cameras", locale === "de" ? "Kameras" : "Cameras"], ["/system", "System"]]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
        await expect(page).toHaveTitle(new RegExp(`${title} · Unifi Protect Archive UI`));
      }
      await page.goto("/archive?period=today");
      const detail = (await cards(page).first().getAttribute("href"))!;
      await page.goto(detail);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(locale === "de" ? "erkannt" : "detected");
      await expect(page.locator("video")).toBeVisible();
      await page.goto("/archive?q=no-such-synthetic-camera");
      await expect(page.getByText(locale === "de" ? "Keine Treffer für „no-such-synthetic-camera“" : "No results for “no-such-synthetic-camera”")).toBeVisible();
      const mediaError = await context.request.get("/api/clips/11111111-1111-4111-8111-111111111111/video", { headers: { "Accept-Language": locale } });
      expect(mediaError.status()).toBe(404);
      expect(mediaError.headers()["cache-control"]).toBe("no-store");
      expect(await mediaError.json()).toEqual({ error: "clip-not-found", message: locale === "de" ? "Clip nicht gefunden" : "Clip not found" });
      await page.goto("/no-such-page");
      await expect(page.getByText(locale === "de" ? "Seite nicht gefunden" : "Page not found", { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test("DE to EN preserves search, camera, dates, route and cookie across reload/new context", async ({ page, context, browser, baseURL }, info) => {
  const errors = browserErrors(page);
  await page.goto("/archive");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await page.getByRole("searchbox", { name: "Archiv durchsuchen" }).fill("Garden");
  await expect(page).toHaveURL(/q=Garden/);
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("group", { name: "Kamera", exact: true }).getByRole("button", { name: "Garden", exact: true }).click();
    await page.getByRole("button", { name: "Fertig", exact: true }).click();
  } else {
    await page.getByRole("combobox", { name: "Kamera", exact: true }).click();
    await page.getByRole("option", { name: "Garden", exact: true }).click();
  }
  await expect(page).toHaveURL(/camera=/);
  await page.getByRole("group", { name: "Zeitraum", exact: true }).getByRole("button", { name: "Zeitraum", exact: true }).click();
  await page.getByLabel("Von", { exact: true }).fill("2026-01-01");
  await page.getByLabel("Bis", { exact: true }).fill("2026-12-31");
  await expect(page).toHaveURL(/to=2026-12-31/);
  await expect(page).toHaveURL(/from=2026-01-01/);
  const url = page.url(), links = await eventLinks(page);
  let documents = 0;
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(page.url()).toBe(url);
  expect(await eventLinks(page)).toEqual(links);
  await expect(page.getByRole("searchbox", { name: "Search archive" })).toHaveValue("Garden");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-01-01");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("2026-12-31");
  expect(documents).toBe(0);
  const cookie = (await context.cookies()).find((item) => item.name === "ui_locale")!;
  expect(cookie.value).toBe("en"); expect(cookie.path).toBe("/"); expect(cookie.sameSite).toBe("Lax"); expect(cookie.httpOnly).toBe(true); expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 86400 * 300);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("searchbox", { name: "Search archive" })).toHaveValue("Garden");
  const reopened = await browser.newContext({ baseURL, locale: "de-DE", storageState: await context.storageState() });
  try { const other = await reopened.newPage(); await other.goto("/cameras"); await expect(other.locator("html")).toHaveAttribute("lang", "en"); } finally { await reopened.close(); }
  await page.getByRole("button", { name: "Deutsch", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  expect(page.url()).toBe(url);
  expect(await eventLinks(page)).toEqual(links);
  expect(errors).toEqual([]);
});

test("language switch preserves loaded pagination", async ({ page }) => {
  await page.goto("/archive");
  await page.getByRole("button", { name: "Mehr laden", exact: true }).click();
  await expect(cards(page)).toHaveCount(46);
  const links = await eventLinks(page);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(cards(page)).toHaveCount(46);
  expect(await eventLinks(page)).toEqual(links);
  await expect(page.locator("main")).not.toContainText("Heute");
  await expect(page.locator("main")).not.toContainText("Gestern");
  await expect(page.getByText("46 events · End of archive")).toBeVisible();
});

test("language switch preserves selected multi-camera clip, playback position and detail route", async ({ page, isMobile }) => {
  const errors = browserErrors(page);
  await page.goto("/archive?period=today");
  const multi = cards(page).filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
  await multi.click(); // Desktop selects the side panel; mobile opens the detail page.
  const tabs = page.getByRole("tablist").getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 4; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(4);
  const src = await video.getAttribute("src"), url = page.url();
  const selectedTab = await tabs.nth(1).getAttribute("id");
  for (const [locale, name] of [["en", "English"], ["de", "Deutsch"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect(page.url()).toBe(url);
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", selectedTab!);
    await expect(video).toHaveAttribute("src", src!);
    expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(4);
    if (!isMobile) await expect(page.getByRole("complementary", { name: locale === "de" ? "Ereignisdetails" : "Event details" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("DE and EN fit 390, 820 and 1440 pixels with keyboard-accessible language controls", async ({ page }) => {
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const locale of ["de", "en"] as const) {
      await page.goto("/archive?period=today");
      const toggle = page.getByRole("button", { name: locale === "de" ? "Deutsch" : "English", exact: true });
      await toggle.focus(); await toggle.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      const bounds = await toggle.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      for (const route of ["/", "/archive?period=today", "/cameras", "/system"]) {
        await page.goto(route);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    }
  }
});
