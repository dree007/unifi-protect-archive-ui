"use server";

import { redirect } from "next/navigation";

import {
  createSessionToken,
  credentialsMatch,
  loginConfig,
  loginLocked,
  recordFailure,
  resetFailures,
  safeNextPath,
} from "@/server/auth/login";
import { clearSessionCookie, setSessionCookie } from "@/server/auth/session";

/** After a failed attempt the form shows the error and keeps the username (React resets the form). */
export type LoginState = { error: "invalid" | "locked" | null; username: string };

export async function signIn(_previous: LoginState, form: FormData): Promise<LoginState> {
  const config = loginConfig();
  if (config.kind !== "enabled") redirect("/");
  const username = form.get("username"), password = form.get("password");
  const typed = typeof username === "string" ? username.slice(0, 200) : "";
  if (loginLocked()) return { error: "locked", username: typed };
  if (typeof username !== "string" || typeof password !== "string" || !credentialsMatch(config, username, password)) {
    recordFailure();
    return { error: "invalid", username: typed };
  }
  resetFailures();
  await setSessionCookie(createSessionToken(config));
  redirect(safeNextPath(form.get("next")));
}

export async function signOut() {
  await clearSessionCookie();
  redirect("/login");
}
