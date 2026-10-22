"use server";

import { getI18n } from "@/i18n/server";
import { parseArchiveFilters } from "@/lib/archive-filters";
import type { CollectionSummary, CurationResult } from "@/lib/collections";
import type { ArchivePageModel, EventDetailModel } from "@/lib/view-models";
import { getArchivePage, getEventDetail } from "@/server/queries/archive";
import { queryContext } from "@/server/queries/context";
import {
  createCollection,
  deleteCollection,
  getEventCuration,
  listCollections,
  renameCollection,
  setEventFavorite,
  setEventInCollection,
} from "@/server/repositories/collections";

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

// --- favorites and collections ------------------------------------------------------------------
// Instance-wide like everything else in the app (no user accounts; access is protected in front
// of the app, docs/security.md). People curate whole events, never single clips. IDs and names
// are validated again in the repository.

async function curate<T>(write: () => Promise<CurationResult<T>>): Promise<CurationResult<T>> {
  try {
    return await write();
  } catch (error) {
    console.error("favorites/collections write failed", error);
    return { ok: false, error: "failed" };
  }
}

export async function setFavorite(eventId: string, favorite: boolean): Promise<CurationResult> {
  return curate(() => setEventFavorite(eventId, favorite === true));
}

/** All collections with event counts, plus the ones `eventId` belongs to (if given). */
export async function loadCollections(
  eventId?: string,
): Promise<CurationResult<{ collections: CollectionSummary[]; memberOf: string[] }>> {
  return curate(async () => {
    const collections = await listCollections();
    if (eventId === undefined) return { ok: true, value: { collections, memberOf: [] } };
    const curation = await getEventCuration(eventId);
    return curation ? { ok: true, value: { collections, memberOf: curation.collectionIds } } : { ok: false, error: "event-not-found" };
  });
}

export async function addCollection(name: string): Promise<CurationResult<CollectionSummary>> {
  return curate(() => createCollection(name));
}

export async function changeCollectionName(collectionId: string, name: string): Promise<CurationResult> {
  return curate(() => renameCollection(collectionId, name));
}

export async function removeCollection(collectionId: string): Promise<CurationResult> {
  return curate(() => deleteCollection(collectionId));
}

export async function setCollectionMembership(collectionId: string, eventId: string, member: boolean): Promise<CurationResult> {
  return curate(() => setEventInCollection(collectionId, eventId, member === true));
}
