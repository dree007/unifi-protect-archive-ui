"use server";

import { getI18n } from "@/i18n/server";
import { parseArchiveFilters } from "@/lib/archive-filters";
import type { ArchivePageModel, EventDetailModel } from "@/lib/view-models";
import { getArchivePage, getEventDetail } from "@/server/queries/archive";
import { queryContext } from "@/server/queries/context";

/**
 * Server functions for the archive's client interactions. Inputs are untrusted: filters are
 * re-parsed from the query string and the cursor is validated by the query layer.
 */

/** Next page for "Mehr laden" (same filters as the URL, cursor from the previous page). */
export async function loadMoreArchiveEvents(filterQuery: string, cursor: string): Promise<ArchivePageModel> {
  const { locale } = await getI18n();
  const filters = parseArchiveFilters(new URLSearchParams(String(filterQuery).slice(0, 1000)));
  return getArchivePage(filters, String(cursor), queryContext({ locale }));
}

/** Details for the desktop side panel; `null` if the event no longer exists. */
export async function loadEventDetail(eventId: string): Promise<EventDetailModel | null> {
  const { locale } = await getI18n();
  return (await getEventDetail(String(eventId), queryContext({ locale }))) ?? null;
}
