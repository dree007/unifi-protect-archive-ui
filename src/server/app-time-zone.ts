import "server-only";

import { isValidTimeZone } from "@/lib/time-zone";

export const DEFAULT_APP_TIME_ZONE = "Europe/Berlin";

/**
 * The application's time zone for all calendar logic and display (APP_TIME_ZONE, default
 * Europe/Berlin). Timestamps in PostgreSQL stay absolute (timestamptz); only "today", day
 * boundaries and formatted times depend on it.
 */
export function resolveAppTimeZone(raw: string | undefined = process.env.APP_TIME_ZONE): string {
  const value = raw?.trim() || DEFAULT_APP_TIME_ZONE;
  if (!isValidTimeZone(value)) {
    throw new Error(`APP_TIME_ZONE "${value}" is not a valid IANA time zone (e.g. Europe/Berlin).`);
  }
  return value;
}
