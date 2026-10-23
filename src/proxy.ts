import { NextResponse, type NextRequest } from "next/server";

import { loginConfig, SESSION_COOKIE, sessionValid } from "@/server/auth/login";

/**
 * Gate of the optional built-in login (src/server/auth/login.ts). Runs before every route,
 * including all /api routes, media byte ranges and server functions; only the login page and the
 * container health check stay public. Without login configuration it only hides /login.
 */
const NO_STORE = { "Cache-Control": "no-store" };

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const config = loginConfig();
  const isLogin = pathname === "/login";

  if (config.kind === "disabled") {
    return isLogin ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (config.kind === "invalid") {
    return new NextResponse(
      "Login configuration is incomplete: set both APP_LOGIN_USERNAME and APP_LOGIN_PASSWORD, or neither.\n",
      { status: 503, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const signedIn = sessionValid(config, request.cookies.get(SESSION_COOKIE)?.value);
  if (signedIn) {
    return isLogin && request.method === "GET" ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (isLogin || pathname === "/api/health") return NextResponse.next();

  if (pathname.startsWith("/api/") || (request.method !== "GET" && request.method !== "HEAD")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  const response = NextResponse.redirect(login);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  // Build assets carry no data; everything else, public files included, passes the gate.
  matcher: ["/((?!_next/static|_next/image|icon\\.svg$|favicon\\.ico$).*)"],
};
