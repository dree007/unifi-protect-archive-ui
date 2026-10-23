import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Optional built-in login (docs/security.md). Off unless both APP_LOGIN_USERNAME and
 * APP_LOGIN_PASSWORD are set; then every route except /login and /api/health needs a session.
 * A half configuration fails closed instead of silently leaving the archive open.
 *
 * Sessions are stateless: a cookie `v1.<expiry>.<signature>`, signed with HMAC-SHA256 under a
 * key derived from username and password by scrypt. Changing either one ends every session;
 * a restart keeps them. No database, no extra secret to manage.
 */
export const SESSION_COOKIE = "archive_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type LoginConfig =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "enabled"; username: string; key: Buffer };

/** scrypt is deliberately slow (~50 ms); it also turns a password guess into a key to compare. */
const scrypt = (username: string, password: string) =>
  scryptSync(password, `protect-archive-ui login v1\0${username}`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

let cached: { id: string; key: Buffer } | undefined;

/** The signing key, derived once per credential pair. */
function deriveKey(username: string, password: string): Buffer {
  const id = `${username}\0${password}`;
  if (cached?.id !== id) cached = { id, key: scrypt(username, password) };
  return cached.key;
}

export function loginConfig(env: Record<string, string | undefined> = process.env): LoginConfig {
  const username = env.APP_LOGIN_USERNAME?.trim() ?? "";
  // The password is taken as is: leading or trailing spaces are part of it.
  const password = env.APP_LOGIN_PASSWORD ?? "";
  if (!username && !password) return { kind: "disabled" };
  if (!username || !password) return { kind: "invalid" };
  return { kind: "enabled", username, key: deriveKey(username, password) };
}

const sign = (key: Buffer, value: string) => createHmac("sha256", key).update(value).digest();

/** Constant-time comparison of two strings of any length (both are MACed first). */
function sameSecret(key: Buffer, given: string, expected: string): boolean {
  return timingSafeEqual(sign(key, `compare\0${given}`), sign(key, `compare\0${expected}`));
}

export function credentialsMatch(config: Extract<LoginConfig, { kind: "enabled" }>, username: string, password: string): boolean {
  // Both checks always run: the response time does not reveal which part was wrong.
  const userOk = sameSecret(config.key, username.trim(), config.username);
  const passwordOk = timingSafeEqual(scrypt(config.username, password), config.key);
  return userOk && passwordOk;
}

export function createSessionToken(config: Extract<LoginConfig, { kind: "enabled" }>, now = Date.now()): string {
  const payload = `v1.${Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS}`;
  return `${payload}.${sign(config.key, payload).toString("base64url")}`;
}

export function sessionValid(config: Extract<LoginConfig, { kind: "enabled" }>, token: string | undefined, now = Date.now()): boolean {
  const match = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!match) return false;
  const expected = sign(config.key, match[1]);
  const given = Buffer.from(match[3], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(match[2]) * 1000 > now;
}

/** Only same-site paths survive as the target after login (no `//host` or `/\host`). */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === "/login" || value.startsWith("/login?") || /[\u0000-\u001f]/.test(value)) return "/";
  return value;
}

/**
 * Failed attempts per process, for all clients together (client addresses behind a proxy are
 * not trustworthy): after 10 failures within 15 minutes further attempts are refused until the
 * oldest one ages out.
 */
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures: number[] = [];

function prune(now: number) {
  while (failures.length > 0 && failures[0] <= now - FAILURE_WINDOW_MS) failures.shift();
}

export function loginLocked(now = Date.now()): boolean {
  prune(now);
  return failures.length >= MAX_FAILURES;
}

export function recordFailure(now = Date.now()) {
  prune(now);
  failures.push(now);
}

export function resetFailures() {
  failures.length = 0;
}
