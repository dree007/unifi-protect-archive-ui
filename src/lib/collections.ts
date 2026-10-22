/**
 * Favorites and collections, shared by server and client: name rules and the result of a
 * write (docs/web-ui.md, "Favorites and collections"). People curate events (situations), never
 * single clips; the links are stored per clip so they survive re-reconciliation. Pure; the
 * database enforces the same rules again (src/server/db/schema/collections.ts).
 */

/** Same limit as the database CHECK constraint. */
export const COLLECTION_NAME_MAX_LENGTH = 60;

/** Why a favorite/collection write was refused; translated in the UI (`collections.error.*`). */
export type CurationError = "invalid-name" | "duplicate-name" | "event-not-found" | "collection-not-found" | "failed";

export interface CollectionSummary {
  id: string;
  name: string;
  /** Events with at least one clip in the collection. */
  eventCount: number;
}

export type CurationResult<T = null> = { ok: true; value: T } | { ok: false; error: CurationError };

/**
 * A collection name as stored: Unicode NFC, trimmed, inner whitespace collapsed. `null` if it is
 * empty, too long or contains control characters (never silently truncated).
 */
export function normalizeCollectionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name || [...name].length > COLLECTION_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) return null;
  return name;
}
