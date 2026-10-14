import { expect, test } from "@playwright/test";

import { createAuthProxy } from "../tests/support/auth-proxy";

test("public product name and metadata fit the narrow header", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Unifi Protect Archive UI$/);
  await expect(page.getByRole("link", { name: /^Unifi Protect Archive UI/ })).toBeVisible();
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute("content", "Unifi Protect Archive UI");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /archived UniFi Protect recordings|Archivierte UniFi-Protect-Aufnahmen/);
  await page.setViewportSize({ width: 320, height: 800 });
  const logo = page.getByRole("link", { name: /^Unifi Protect Archive UI/ });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
});

test("external gate covers pages, direct APIs, conditional requests, Range and HEAD", async ({ page, request, baseURL }) => {
  const proxy = await createAuthProxy(baseURL!);
  try {
    proxy.setAuthorized(true);
    await page.goto(`${proxy.url}/archive?period=all`);
    const card = page.locator('main ol > li > a[href^="/archive/"]').first();
    const thumbnail = (await card.locator("img[data-thumbnail]").first().getAttribute("src"))!;
    const detail = (await card.getAttribute("href"))!;
    const video = thumbnail.split("/thumbnail")[0] + "/video";
    const thumb = await request.get(proxy.url + thumbnail);
    expect(thumb.status()).toBe(200);
    expect(thumb.headers()["cache-control"]).toBe("no-store");
    expect((await thumb.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const range = await request.get(proxy.url + video, { headers: { Range: "bytes=0-1023" } });
    expect(range.status()).toBe(206);
    expect(range.headers()["cache-control"]).toBe("no-store");
    expect(range.headers()["content-range"]).toMatch(/^bytes 0-1023\/\d+$/);
    expect((await range.body()).length).toBe(1024);

    // Exercise hydrated UI/navigation through the gate, not only raw API requests.
    await page.getByRole("searchbox", { name: "Archiv durchsuchen" }).fill("Garden");
    await expect(page).toHaveURL(/q=Garden/);
    await page.goto(proxy.url + detail);
    const player = page.locator("video");
    await player.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
    await player.evaluate((element: HTMLVideoElement) => { element.currentTime = 6; });
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(6);
    expect(await player.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
    await player.evaluate((element: HTMLVideoElement) => element.pause());

    proxy.setAuthorized(false); // external access decision changed; no app logout/session API
    const cases: { path: string; method: string; headers?: Record<string, string> }[] = [
      { path: "/", method: "GET" },
      { path: "/archive", method: "GET" },
      { path: "/cameras", method: "GET" },
      { path: "/system", method: "GET" },
      { path: detail, method: "GET" },
      { path: "/api/health", method: "GET" },
      { path: thumbnail, method: "GET" },
      { path: video, method: "GET" },
      { path: video, method: "GET", headers: { Range: "bytes=0-1023" } },
      { path: video, method: "HEAD" },
      { path: video, method: "HEAD", headers: { Range: "bytes=0-1023" } },
      { path: thumbnail, method: "GET", headers: { "If-None-Match": thumb.headers().etag } },
      { path: video, method: "GET", headers: { "If-None-Match": range.headers().etag } },
      { path: video, method: "GET", headers: { "X-Authentik-Username": "forged-test-user" } },
    ];
    for (const { path, method, headers } of cases) {
      const denied = await request.fetch(proxy.url + path, { method, headers });
      expect(denied.status(), `${method} ${path}`).toBe(401);
      expect(denied.headers()["cache-control"]).toBe("no-store");
      for (const header of ["etag", "last-modified", "content-range", "accept-ranges", "x-thumbnail-error"]) {
        expect(denied.headers()[header], header).toBeUndefined();
      }
      expect((await denied.body()).length).toBe(0);
    }
  } finally {
    await page.goto("about:blank");
    await proxy.close();
  }
});

test("browser refetches private media and is denied after simulated external logout", async ({ page, baseURL }) => {
  const proxy = await createAuthProxy(baseURL!);
  try {
    proxy.setAuthorized(true);
    // No page.route/request interception: those disable Chromium's HTTP cache and could hide R02.
    await page.goto(`${proxy.url}/archive?period=all`);
    const thumbnail = (await page.locator("img[data-thumbnail]").first().getAttribute("src"))!;
    const video = thumbnail.split("/thumbnail")[0] + "/video";
    const fetchMedia = () => page.evaluate(async ({ thumbnail, video }) => {
      const results = [];
      const inputs: { url: string; init?: RequestInit }[] = [
        { url: thumbnail },
        { url: video },
        { url: video, init: { headers: { Range: "bytes=0-1023" } } },
        { url: video, init: { method: "HEAD" } },
      ];
      for (const { url, init } of inputs) {
        // A fixed diagnostic header distinguishes these fetches from background image loads.
        // No changing URL/cache-buster, no cache mode, and the response does not Vary on it.
        const headers = new Headers(init?.headers);
        headers.set("X-UniFi-Test-Probe", "cache-regression");
        const response = await fetch(url, { ...init, headers });
        results.push({ status: response.status, cache: response.headers.get("cache-control"), bytes: (await response.arrayBuffer()).byteLength });
      }
      return results;
    }, { thumbnail, video });
    const before = await fetchMedia();
    expect(before.map((result) => result.status)).toEqual([200, 200, 206, 200]);
    expect(before.every((result) => result.cache === "no-store")).toBe(true);
    expect(before[0].bytes).toBeGreaterThan(0);
    expect(before[2].bytes).toBe(1024);
    // Repeat without revocation: normal cache-hit delivery remains no-store, requests reach gate.
    const count = () => proxy.requests.filter((item) => item.cacheProbe).length;
    const prior = count();
    expect((await fetchMedia()).map((result) => result.status)).toEqual([200, 200, 206, 200]);
    expect(count() - prior).toBe(4);
    proxy.setAuthorized(false);
    const atLogout = count();
    const after = await fetchMedia();
    expect(after.map((result) => result.status)).toEqual([401, 401, 401, 401]);
    expect(after.every((result) => result.bytes === 0 && result.cache === "no-store")).toBe(true);
    expect(count() - atLogout).toBe(4); // none reused an HTTP/browser cache entry
    const response = await page.goto(proxy.url + thumbnail);
    expect(response!.status()).toBe(401);
  } finally {
    await page.goto("about:blank");
    await proxy.close();
  }
});

test("fingerprinted Next assets keep their immutable cache policy", async ({ page, request }) => {
  await page.goto("/archive");
  const asset = await page.locator('script[src*="/_next/static/"]').first().getAttribute("src");
  expect(asset).toBeTruthy();
  const response = await request.get(asset!);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("immutable");
  expect(response.headers()["cache-control"]).not.toContain("no-store");
});
