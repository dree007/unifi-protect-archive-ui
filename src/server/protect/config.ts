/**
 * Configuration of the UniFi Protect integration. Read and validated only when a Protect
 * command actually runs, never at import or build time.
 */

export interface ProtectConfig {
  /** Normalized base URL without trailing slash, e.g. `https://192.168.0.1`. */
  baseUrl: string;
  /** Secret. Never log or include in error messages. */
  apiKey: string;
  /**
   * Verify the TLS certificate. `false` only affects this application's Protect clients
   * (per-connection option), never the process-wide TLS settings.
   */
  tlsVerify: boolean;
}

/** Invalid or missing configuration: retrying cannot help. */
export class ProtectConfigError extends Error {
  override name = "ProtectConfigError";
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

export function parseTlsVerify(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return true;
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new ProtectConfigError(`UNIFI_PROTECT_TLS_VERIFY must be "true" or "false", got "${raw}".`);
}

export function normalizeProtectUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new ProtectConfigError("UNIFI_PROTECT_URL is not set (e.g. https://192.168.0.1).");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtectConfigError(`UNIFI_PROTECT_URL is not a valid URL: "${value}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProtectConfigError(`UNIFI_PROTECT_URL must use https:// (or http://), got "${url.protocol}".`);
  }
  if (url.username || url.password) {
    throw new ProtectConfigError("UNIFI_PROTECT_URL must not contain credentials; use UNIFI_PROTECT_API_KEY.");
  }
  if (url.search || url.hash) {
    throw new ProtectConfigError("UNIFI_PROTECT_URL must not contain a query string or fragment.");
  }
  // Keep an optional path prefix (e.g. behind a reverse proxy), but no trailing slash.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Reads and validates UNIFI_PROTECT_URL, UNIFI_PROTECT_API_KEY and UNIFI_PROTECT_TLS_VERIFY. */
export function readProtectConfig(env: Record<string, string | undefined> = process.env): ProtectConfig {
  const baseUrl = normalizeProtectUrl(env.UNIFI_PROTECT_URL);
  const apiKey = env.UNIFI_PROTECT_API_KEY?.trim();
  if (!apiKey) {
    throw new ProtectConfigError(
      "UNIFI_PROTECT_API_KEY is not set. Create an API key in UniFi (Integrations) and set it in .env.local.",
    );
  }
  return { baseUrl, apiKey, tlsVerify: parseTlsVerify(env.UNIFI_PROTECT_TLS_VERIFY) };
}

/** Human-readable hints about weakened transport security (for CLI start-up output). */
export function securityNotes(config: ProtectConfig): string[] {
  const notes: string[] = [];
  if (config.baseUrl.startsWith("http:")) notes.push("Protect is accessed via plain http (prefer https).");
  if (config.baseUrl.startsWith("https:") && !config.tlsVerify) {
    notes.push("TLS certificate verification is disabled for Protect (UNIFI_PROTECT_TLS_VERIFY=false).");
  }
  return notes;
}
