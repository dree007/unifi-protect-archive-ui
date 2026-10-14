"use server";

import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, LOCALE_MAX_AGE } from "./core";

export async function setLocale(value: unknown) {
  if (!isLocale(value)) throw new Error("Unsupported locale");
  const requestHeaders = await headers();
  // Browsers send Origin for POST actions. Do not trust a client-supplied locale as protocol.
  const origin = requestHeaders.get("origin");
  const secure = origin?.startsWith("https://") ?? requestHeaders.get("x-forwarded-proto") === "https";
  (await cookies()).set(LOCALE_COOKIE, value, { path: "/", sameSite: "lax", secure, httpOnly: true, maxAge: LOCALE_MAX_AGE });
  // Next rerenders the current tree after changing the cookie; no redundant router.refresh.
}
