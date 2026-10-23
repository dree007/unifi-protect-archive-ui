import "server-only";

import { cookies, headers } from "next/headers";

import { loginConfig, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionValid } from "./login";

/**
 * Second check inside server functions: the proxy already gates their routes, but a server
 * function must not rely on a matcher alone (Next.js data-security guidance).
 */
export async function requireSession(): Promise<void> {
  const config = loginConfig();
  if (config.kind === "disabled") return;
  if (config.kind === "enabled" && sessionValid(config, (await cookies()).get(SESSION_COOKIE)?.value)) return;
  throw new Error("Not signed in");
}

/** HTTPS as seen by the browser (directly or through a TLS-terminating proxy). */
async function secureRequest(): Promise<boolean> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  return origin?.startsWith("https://") ?? requestHeaders.get("x-forwarded-proto") === "https";
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: await secureRequest(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}
