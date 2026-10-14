import { findPgError } from "@/server/db/errors";

/**
 * Error messages that are persisted for, or shown on, the system page: no secrets, no internal
 * absolute paths, bounded length. Applied when the worker stores a message and again when the
 * page reads one (scan runs are also written by the CLI).
 */

const MAX_LENGTH = 400;

export interface SanitizeOptions {
  /** ARCHIVE_ROOT; replaced by its name. */
  archiveRoot?: string | null;
  /** Further secret values that must never appear (API key, passwords). */
  secrets?: readonly (string | undefined)[];
}

export function sanitizeStatusMessage(message: string, { archiveRoot, secrets = [] }: SanitizeOptions = {}): string {
  let text = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("***");
  }
  // Credentials inside URLs (postgresql://user:password@host, https://user:pass@host).
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
  if (archiveRoot && archiveRoot !== "/") {
    // `ARCHIVE_ROOT “/srv/nas” does not exist` → `ARCHIVE_ROOT does not exist`
    text = text.split(`ARCHIVE_ROOT “${archiveRoot}”`).join("ARCHIVE_ROOT").split(archiveRoot).join("ARCHIVE_ROOT");
  }
  // Any other absolute path with at least two segments. Protect API paths (/proxy/…) are no
  // internal detail and stay readable.
  text = text.replace(/(^|[\s“"'(=])\/(?!proxy\/)[^\s”"')]+\/[^\s”"')]*/g, "$1<Pfad>");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}

/** One line about an error; for database errors the PostgreSQL message, not Drizzle's query dump. */
export function describeError(error: unknown): string {
  const pgError = findPgError(error);
  if (pgError) return pgError.code ? `${pgError.message} (SQLSTATE ${pgError.code})` : pgError.message;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
