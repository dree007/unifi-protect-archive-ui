import type { Locale } from "@/i18n/core";
import "server-only";

import { createDateFormat, type DateFormat } from "@/lib/date-format";
import { resolveAppTimeZone } from "@/server/app-time-zone";
import { getDb } from "@/server/db/client";
import type { DbExecutor } from "@/server/db/types";

/** Everything a query needs: database, current time and the app time zone. */
export interface QueryContext {
  db: DbExecutor;
  now: Date;
  timeZone: string;
  locale: Locale;
  format: DateFormat;
}

/** Context for a request: real clock, APP_TIME_ZONE, shared pool. Overridable in tests. */
export function queryContext(overrides: Partial<Pick<QueryContext, "db" | "now" | "timeZone" | "locale">> = {}): QueryContext {
  const timeZone = overrides.timeZone ?? resolveAppTimeZone();
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? new Date(),
    timeZone,
    locale: overrides.locale ?? "de",
    format: createDateFormat(timeZone, overrides.locale ?? "de"),
  };
}

/** Timestamps arrive as strings or Dates depending on the query path; normalize to Date. */
export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toDateOrNull(value: string | Date | null): Date | null {
  return value === null ? null : toDate(value);
}
