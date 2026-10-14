import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * End-to-end tests against the environment of e2e/prepare.mts (relative to "today" in Berlin):
 *
 *   today      08:00 Garden (person) · 07:00 Driveway + Doorbell (person, 2 cameras)
 *              06:00 Doorbell (package, pending – no clip)
 *   yesterday  18:30 Garden (archive only)
 *   3 days     12:15 Driveway (archive only) · 09:45 Garage 2 (animal)
 *   10 days    10:00 Garden · 11–45 days: 06:30 Garden (35×)
 *   50 days    14:20 Driveway + Doorbell, no Protect events (temporal fallback)
 *   51 days    16:10 Driveway (person) + Garage 2 without metadata (mixed: one event)
 *   52 days    11:05 Driveway (vehicle) · Doorbell (person): grouped by time first, then split
 *                                                                          → 46 events, 38 × Garden
 */

const ALL_EVENTS = 46;
const GARDEN_EVENTS = 38;
const PAGE_SIZE = 30;

const cards = (page: Page) => page.locator('main ol > li > a[href^="/archive/"]');
const labels = async (page: Page) => (await cards(page).evaluateAll((links) => links.map((a) => a.getAttribute("aria-label") ?? "")));
const search = (page: Page) => page.getByRole("searchbox", { name: "Archiv durchsuchen" });
const chip = (page: Page, name: string) => page.getByRole("group", { name: "Zeitraum" }).getByRole("button", { name, exact: true });

async function openArchive(page: Page, query = "") {
  await page.goto(`/archive${query}`);
  await expect(cards(page).first()).toBeVisible();
}

/** Thumbnails inside `scope` that really show pixels (loaded, visible, not hidden by CSS). */
async function visibleThumbnails(scope: Locator) {
  return scope.locator("img[data-thumbnail]").evaluateAll((images) =>
    images.filter((img) => {
      const image = img as HTMLImageElement;
      return image.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === "1" && getComputedStyle(image).visibility === "visible";
    }).length,
  );
}

test.describe("thumbnails", () => {
  test("load as real JPEGs and stay visible", async ({ page }) => {
    const responses: { status: number; type: string | null }[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/thumbnail")) responses.push({ status: response.status(), type: response.headers()["content-type"] ?? null });
    });
    await openArchive(page);
    const first = cards(page).first();
    await expect.poll(() => visibleThumbnails(first)).toBe(1);
    await page.waitForTimeout(1000); // still visible after hydration and later renders
    expect(await visibleThumbnails(first)).toBe(1);
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every((response) => response.status === 200 && response.type === "image/jpeg")).toBe(true);
  });

  test("a multi-camera event shows both thumbnails, a pending event none", async ({ page }) => {
    await openArchive(page, "?period=today");
    const multi = cards(page).filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
    await expect(multi).toHaveCount(1);
    await expect.poll(() => visibleThumbnails(multi)).toBe(2);

    const pending = cards(page).filter({ has: page.getByRole("img", { name: "Aufnahme ausstehend" }) });
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("img[data-thumbnail]")).toHaveCount(0);
  });

  test("versioned URLs, private no-store responses and image/jpeg", async ({ page, request }) => {
    await openArchive(page);
    const src = await cards(page).first().locator("img[data-thumbnail]").first().getAttribute("src");
    expect(src).toMatch(/^\/api\/clips\/[0-9a-f-]{36}\/thumbnail\?v=[0-9a-z]+-[0-9a-z]+$/);
    const response = await request.get(src!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/jpeg");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect((await response.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  test("fall back to the soft placeholder on HTTP errors", async ({ page }) => {
    await page.route("**/api/clips/*/thumbnail*", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", headers: { "X-Thumbnail-Error": "ffmpeg-missing" }, body: "{}" }),
    );
    await openArchive(page);
    const first = cards(page).first();
    await expect(first.locator("img[data-thumbnail]")).toHaveCount(0);
    await expect(first.getByRole("img").first()).toBeVisible(); // placeholder with its label
  });
});

test.describe("text search", () => {
  test("filters on the server, updates the URL and can be cleared", async ({ page }) => {
    await openArchive(page);
    await expect(cards(page)).toHaveCount(PAGE_SIZE);

    await search(page).fill("Garden");
    await expect(page).toHaveURL(/\/archive\?q=Garden$/);
    await expect.poll(async () => (await labels(page)).every((label) => label.includes("Garden"))).toBe(true);
    await expect(cards(page)).toHaveCount(PAGE_SIZE);

    // Case-insensitive, also via the URL
    await openArchive(page, "?q=driveWAY");
    // today's multi-camera event, 12:15 three days ago, and the grouping scenarios (50–52 days)
    expect(await labels(page)).toHaveLength(5);
    expect((await labels(page)).every((label) => label.includes("Driveway"))).toBe(true);

    await search(page).fill("");
    await expect(page).toHaveURL(/\/archive$/);
    await expect(cards(page)).toHaveCount(PAGE_SIZE);
  });

  test("finds a multi-camera event via both cameras and detections by label", async ({ page }) => {
    for (const query of ["Doorbell", "Driveway", "Person"]) {
      await openArchive(page, `?q=${query}&period=today`);
      expect(await labels(page), query).toEqual(expect.arrayContaining([expect.stringContaining("Doorbell, Driveway")]));
    }
    await openArchive(page, "?q=Person");
    // Garden 08:00, the multi-camera event, the mixed event (51 days) and Doorbell after the split
    expect(await labels(page)).toHaveLength(4);
  });

  test("shows an empty state without matches", async ({ page }) => {
    await page.goto("/archive?q=gibt-es-nicht");
    await expect(page.getByText("Keine Treffer für „gibt-es-nicht“")).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
  });

  test("typing then quickly changing the period keeps both", async ({ page }) => {
    await openArchive(page);
    await search(page).pressSequentially("Garden", { delay: 20 });
    await chip(page, "Heute").click();
    await expect(page).toHaveURL(/q=Garden/);
    await expect(page).toHaveURL(/period=today/);
    await expect(cards(page)).toHaveCount(1);
    await expect(search(page)).toHaveValue("Garden");
  });
});

test.describe("periods", () => {
  test("today, 7 and 30 days use calendar days in Europe/Berlin", async ({ page }) => {
    await openArchive(page);
    await chip(page, "Heute").click();
    await expect(page).toHaveURL(/period=today/);
    await expect(cards(page)).toHaveCount(3);
    await expect(chip(page, "Heute")).toHaveAttribute("aria-pressed", "true");

    await chip(page, "7 Tage").click();
    await expect(page).toHaveURL(/period=7d/);
    await expect(cards(page)).toHaveCount(6);

    await chip(page, "30 Tage").click();
    await expect(page).toHaveURL(/period=30d/);
    // today … 29 days ago: 6 recent + 10 days + 11…29 days (19) = 26
    await expect(cards(page)).toHaveCount(26);

    await chip(page, "Alle").click();
    await expect(page).toHaveURL(/\/archive$/);
    await expect(cards(page)).toHaveCount(PAGE_SIZE);
  });

  test("custom range: both dates in the URL, whole days, kept after navigation", async ({ page }) => {
    await openArchive(page);
    await chip(page, "Zeitraum").click();
    await expect(page).toHaveURL(/period=custom/);
    const day = await page.evaluate(() => {
      const d = new Date(Date.now() - 3 * 86_400_000);
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
    });
    await page.getByLabel("Von", { exact: true }).fill(day);
    await expect(page).toHaveURL(new RegExp(`from=${day}`));
    await page.getByLabel("Bis", { exact: true }).fill(day);
    await expect(page).toHaveURL(new RegExp(`from=${day}&to=${day}`));
    await expect(cards(page)).toHaveCount(2);
    expect((await labels(page)).join(" | ")).toMatch(/Driveway.*\|.*Garage 2/);

    await page.reload();
    await expect(page.getByLabel("Von", { exact: true })).toHaveValue(day);
    await expect(page.getByLabel("Bis", { exact: true })).toHaveValue(day);
    await expect(cards(page)).toHaveCount(2);
  });

  test("start after end is explained, not swapped", async ({ page }) => {
    await page.goto("/archive?period=custom&from=2026-10-05&to=2026-10-01");
    await expect(page.getByText("Das Startdatum liegt nach dem Enddatum.").first()).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await page.goto("/archive?period=custom&from=2026-02-30");
    await expect(page.getByText("Das Startdatum ist ungültig und wird ignoriert.")).toBeVisible();
  });
});

test.describe("combined filters, pagination and history", () => {
  test("search + period + camera, reset, „Mehr laden“ and back/forward", async ({ page, isMobile }) => {
    await openArchive(page);
    await search(page).fill("Garden");
    await expect(page).toHaveURL(/q=Garden/);

    // „Mehr laden“ with a filter: 30 + 8, no duplicates, end message
    await page.getByRole("button", { name: "Mehr laden" }).click();
    await expect(cards(page)).toHaveCount(GARDEN_EVENTS);
    const ids = await cards(page).evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(new Set(ids).size).toBe(GARDEN_EVENTS);
    await expect(page.getByText(`${GARDEN_EVENTS} Ereignisse · keine weiteren Treffer`)).toBeVisible();

    // A filter change starts a new list instead of appending to the loaded pages
    await chip(page, "7 Tage").click();
    await expect(page).toHaveURL(/q=Garden&period=7d/);
    await expect(cards(page)).toHaveCount(2);

    // Camera filter in addition
    if (isMobile) {
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.getByRole("dialog").getByRole("group", { name: "Kamera" }).getByRole("button", { name: "Garden", exact: true }).click();
      await page.getByRole("button", { name: "Fertig" }).click();
    } else {
      await page.getByRole("combobox", { name: "Kamera" }).click();
      await page.getByRole("option", { name: "Garden", exact: true }).click();
    }
    await expect(page).toHaveURL(/camera=[0-9a-f-]{36}/);
    await expect(cards(page)).toHaveCount(2);

    // Clear the search: the other filters stay
    await page.getByRole("button", { name: "Suche leeren" }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page).toHaveURL(/period=7d&camera=/);
    await expect(cards(page)).toHaveCount(2);

    // Back restores the previous filter state, forward again
    await page.goBack();
    await expect(page).toHaveURL(/q=Garden&period=7d&camera=/);
    await expect(search(page)).toHaveValue("Garden");
    await page.goBack();
    await expect(page).toHaveURL(/q=Garden&period=7d$/);
    await page.goForward();
    await expect(page).toHaveURL(/q=Garden&period=7d&camera=/);

    // Reset everything
    await page.goto("/archive?q=Garden&period=today");
    await chip(page, "Alle").click();
    await expect(page).toHaveURL(/\/archive\?q=Garden$/);
  });

  test("„Mehr laden“ without filters reaches the end without duplicates", async ({ page }) => {
    await openArchive(page);
    await page.getByRole("button", { name: "Mehr laden" }).click();
    await expect(cards(page)).toHaveCount(ALL_EVENTS);
    const ids = await cards(page).evaluateAll((links) => links.map((a) => a.getAttribute("href")!.split("?")[0]));
    expect(new Set(ids).size).toBe(ALL_EVENTS);
    await expect(page.getByText(`${ALL_EVENTS} Ereignisse · Ende des Archivs`)).toBeVisible();
  });
});

test.describe("event detail and video", () => {
  test("open from a filtered list, switch clips, play, seek, return to the list", async ({ page, isMobile }) => {
    const ranges: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/video")) ranges.push(response.status());
    });
    await openArchive(page, "?q=Doorbell&period=today");
    const multi = cards(page).filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
    const href = await multi.getAttribute("href");
    expect(href).toContain(`from=${encodeURIComponent("q=Doorbell&period=today")}`);
    if (isMobile) await multi.click();
    else await page.goto(href!); // desktop opens the side panel on click; the page is tested here
    await expect(page).toHaveURL(/\/archive\/[0-9a-f-]{36}/);

    const tabs = page.getByRole("tablist", { name: "Aufnahme auswählen" }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

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
    expect(ranges).toContain(206);

    await page.getByRole("link", { name: "Zurück zum Archiv" }).click();
    await expect(page).toHaveURL(/\/archive\?q=Doorbell&period=today$/);
    await expect(search(page)).toHaveValue("Doorbell");
    await expect(cards(page)).toHaveCount(2);
  });

  test("desktop side panel loads the selected event", async ({ page, isMobile }) => {
    test.skip(isMobile, "side panel only from 80rem");
    await openArchive(page, "?period=today");
    await cards(page).nth(1).click();
    const panel = page.getByRole("complementary", { name: "Ereignisdetails" });
    await expect(panel.getByRole("tablist", { name: "Aufnahme auswählen" })).toBeVisible();
    await expect(page).toHaveURL(/\/archive\?period=today$/);
  });
});

test.describe("multi-camera grouping", () => {
  /** The archive of one day `daysAgo` days back (custom range), as list of cards. */
  async function openDay(page: Page, daysAgo: number) {
    const day = await page.evaluate(
      (days) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() - days * 86_400_000)),
      daysAgo,
    );
    await openArchive(page, `?period=custom&from=${day}&to=${day}`);
  }
  async function openDetail(page: Page, card: Locator, isMobile: boolean) {
    if (isMobile) await card.click();
    else await page.goto((await card.getAttribute("href"))!);
    await expect(page).toHaveURL(/\/archive\/[0-9a-f-]{36}/);
  }
  const grouping = (page: Page) => page.getByRole("region", { name: "Zuordnung der Kameras" });

  test("historic clips without metadata: one card, both cameras, „Zeitlich zugeordnet“", async ({ page, isMobile }) => {
    await openDay(page, 50);
    await expect(cards(page)).toHaveCount(1);
    const card = cards(page).first();
    await expect(card).toHaveAttribute("aria-label", /Doorbell, Driveway/);
    await expect(card.getByText("Zeitlich zugeordnet")).toBeVisible();
    await expect(card.getByText("Erkennungen abgeglichen")).toHaveCount(0);
    await expect.poll(() => visibleThumbnails(card)).toBe(2);

    await openDetail(page, card, isMobile);
    await expect(page.getByRole("tablist", { name: "Aufnahme auswählen" }).getByRole("tab")).toHaveCount(2);
    await expect(grouping(page)).toContainText("sehr ähnlicher Aufnahmezeiten");
    await expect(grouping(page).getByRole("listitem")).toHaveText([/Doorbell\s*zeitlich zugeordnet/, /Driveway\s*zeitlich zugeordnet/]);
    await expect(page.getByText("Archivclip").first()).toBeVisible(); // status stays archiveOnly
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("mixed: Protect confirmed one camera only – the detail says so per camera", async ({ page, isMobile }) => {
    await openDay(page, 51);
    await expect(cards(page)).toHaveCount(1);
    const card = cards(page).first();
    await expect(card).toHaveAttribute("aria-label", /Driveway, Garage 2/);
    await expect(card.getByText("Zeitlich zugeordnet")).toBeVisible();

    await openDetail(page, card, isMobile);
    await expect(grouping(page).getByRole("listitem")).toHaveText([/Garage 2\s*zeitlich zugeordnet/, /Driveway\s*Erkennung von Protect/]);
    await expect(page.getByRole("tablist", { name: "Aufnahme auswählen" }).getByRole("tab")).toHaveCount(2);
  });

  test("metadata grouping is labelled quietly as „Erkennungen abgeglichen“", async ({ page }) => {
    await openArchive(page, "?period=today");
    const multi = cards(page).filter({ has: page.locator('[aria-label*="Doorbell"][aria-label*="Driveway"]') });
    await expect(multi.getByText("Erkennungen abgeglichen")).toBeVisible();
    await expect(multi.getByText("Zeitlich zugeordnet")).toHaveCount(0);
    // Single-camera events carry no grouping hint at all.
    const single = cards(page).filter({ hasText: "08:00" });
    await expect(single.getByText(/Zeitlich zugeordnet|Erkennungen abgeglichen/)).toHaveCount(0);
  });

  test("after a split: two events, each with its own camera and working detail", async ({ page, isMobile }) => {
    await openDay(page, 52);
    await expect(cards(page)).toHaveCount(2);
    const all = await labels(page);
    expect(all.some((label) => /Doorbell/.test(label) && !/Driveway/.test(label))).toBe(true);
    expect(all.some((label) => /Driveway/.test(label) && !/Doorbell/.test(label))).toBe(true);
    await expect(page.getByText(/Zeitlich zugeordnet|Erkennungen abgeglichen/)).toHaveCount(0);

    await openDetail(page, cards(page).first(), isMobile);
    await expect(page.locator("video")).toBeVisible();
    await expect(grouping(page)).toHaveCount(0);
  });

  test("search finds the grouped events via each camera", async ({ page }) => {
    // today 07:00 (metadata), 06:00 pending, 50 days (temporal), 52 days (Doorbell after the split)
    await openArchive(page, "?q=Doorbell");
    await expect(cards(page)).toHaveCount(4);
    await openArchive(page, "?q=Garage");
    expect(await labels(page)).toEqual(expect.arrayContaining([expect.stringMatching(/Driveway, Garage 2/)]));
  });
});

test.describe("without hydration", () => {
  // The original bug: `next dev` opened via a LAN IP blocked the JS bundles (allowedDevOrigins),
  // React never hydrated – thumbnails stayed invisible, search and period chips did nothing.
  // Same situation here: the app's JS bundles are blocked, the server-rendered page remains.
  test.beforeEach(async ({ page }) => {
    await page.route("**/_next/static/chunks/**", (route) => route.abort());
  });

  test("thumbnails are visible and period chips and search still filter", async ({ page }) => {
    await page.goto("/archive");
    await expect(cards(page).first()).toBeVisible();
    await expect.poll(() => visibleThumbnails(cards(page).first())).toBe(1);

    await chip(page, "Heute").click();
    await expect(page).toHaveURL(/period=today/);
    await expect(cards(page)).toHaveCount(3);

    await search(page).fill("Garden");
    await search(page).press("Enter");
    await expect(page).toHaveURL(/q=Garden/);
    await expect(page).toHaveURL(/period=today/);
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe("layout", () => {
  for (const path of ["/", "/archive", "/archive?q=Garden&period=7d", "/archive?period=custom&from=2026-10-01&to=2026-10-05", "/cameras", "/system"]) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("no horizontal overflow on an event detail page", async ({ page }) => {
    await openArchive(page, "?period=today");
    await page.goto((await cards(page).nth(1).getAttribute("href"))!);
    await expect(page.locator("video")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("navigation marks the current page", async ({ page, isMobile }) => {
    await page.goto("/cameras");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" }).filter({ visible: true });
    await expect(nav.getByRole("link", { name: "Kameras" })).toHaveAttribute("aria-current", "page");
    if (isMobile) {
      // Touch targets of the bottom bar: at least 44 × 44 px
      const box = await nav.getByRole("link", { name: "Archiv" }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });
});
