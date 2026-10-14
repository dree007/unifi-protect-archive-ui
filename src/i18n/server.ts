import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createTranslator, detectLocale, LOCALE_COOKIE, type Locale, type Messages } from "./core";

export const getI18n = cache(async () => {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const locale = detectLocale(cookieStore.get(LOCALE_COOKIE)?.value, requestHeaders.get("accept-language"));
  const messages = await loadMessages(locale);
  return { locale, messages, t: createTranslator(locale, messages) };
});

export async function loadMessages(locale: Locale): Promise<Messages> {
  return locale === "de" ? (await import("./messages/de.json")).default : (await import("./messages/en.json")).default;
}
