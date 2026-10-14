import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => ({ cookie: undefined as string | undefined, headers: new Map<string, string>(), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: request.cookie }), set: request.set }), headers: async () => ({ get: (key: string) => request.headers.get(key) ?? null }) }));
import { getI18n } from "@/i18n/server";
import { setLocale } from "@/i18n/actions";
import { LOCALE_MAX_AGE } from "@/i18n/core";

describe("server locale and cookie action", () => {
  beforeEach(() => { request.cookie = undefined; request.headers.clear(); request.set.mockReset(); });
  it("SSR and dictionary share the negotiated locale", async () => {
    request.headers.set("accept-language", "de-DE,en;q=0.8");
    const result = await getI18n(); expect(result.locale).toBe("de"); expect(result.t("common.archive")).toBe("Archiv");
    request.cookie = "en";
    const english = await getI18n(); expect(english.locale).toBe("en"); expect(english.t("common.archive")).toBe("Archive");
  });
  it("rejects unsupported cookies and action values", async () => {
    request.cookie = "<script>"; expect((await getI18n()).locale).toBe("en");
    await expect(setLocale("de-DE")).rejects.toThrow(/Unsupported/); expect(request.set).not.toHaveBeenCalled();
  });
  it.each([false, true])("writes persistent secure=%s host-only cookie, with no redirect", async (secure) => {
    request.headers.set("origin", `${secure ? "https" : "http"}://archive.example.com`);
    await setLocale("de");
    expect(request.set).toHaveBeenCalledWith("ui_locale", "de", { path: "/", sameSite: "lax", httpOnly: true, secure, maxAge: LOCALE_MAX_AGE });
  });
});
