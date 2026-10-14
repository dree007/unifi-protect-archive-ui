import { expect, test } from "@playwright/test";

for (const locale of ["de-DE", "en-GB"]) {
  test(`release footer and exact legal assets are usable in ${locale}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const footer = page.locator("footer");
      await expect(footer).toContainText("Version 1.0.0");
      await expect(footer.getByRole("link", { name: locale === "de-DE" ? "Lizenz (AGPL-3.0-only)" : "License (AGPL-3.0-only)", exact: true })).toHaveAttribute("href", "/notices/LICENSE.txt");
      await expect(footer.getByRole("link", { name: locale === "de-DE" ? "Drittanbieter-Hinweise" : "Third-party notices", exact: true })).toHaveAttribute("href", "/notices/THIRD_PARTY_NOTICES.md");
      await expect(footer.getByRole("link", { name: locale === "de-DE" ? "Quellcode" : "Source code", exact: true })).toHaveAttribute("href", "https://source.example.invalid/releases/1.0.0");
      const license = await context.request.get("/notices/LICENSE.txt");
      expect(license.status()).toBe(200);
      expect(await license.text()).toContain("13. Remote Network Interaction; Use with the GNU General Public License.");
      const notices = await context.request.get("/notices/THIRD_PARTY_NOTICES.md");
      expect(notices.status()).toBe(200);
      expect(await notices.text()).toContain("shadcn/ui");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(footer).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
}

test("private thumbnails cannot be recached by the unused Next image optimizer", async ({ page, request }) => {
  await page.goto("/archive");
  const image = page.locator('img[data-thumbnail]').first();
  await expect(image).toBeVisible();
  const source = await image.getAttribute("src");
  const response = await request.get(`/_next/image?url=${encodeURIComponent(source!)}&w=640&q=75`);
  expect(response.status()).toBe(404);
});
