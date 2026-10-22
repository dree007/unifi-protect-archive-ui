import { isDayKey } from "./time-zone";

/**
 * Archive filters as they live in the URL (`/archive?q=Garten&period=7d&camera=…&type=person&fav=1`).
 * Pure: parsing, serializing and safe "back to archive" links. Filtering itself happens in
 * PostgreSQL (src/server/queries/archive.ts); semantics in docs/web-ui.md.
 */

export const PERIODS = ["all", "today", "7d", "30d", "custom"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  all: "Alle",
  today: "Heute",
  "7d": "7 Tage",
  "30d": "30 Tage",
  custom: "Zeitraum",
};

/** `all`, `none` (no detection metadata) or any Protect detection type. */
export type DetectionFilter = string;

export interface ArchiveFilters {
  query: string;
  period: Period;
  /** `YYYY-MM-DD` in the app time zone, only for `custom`. */
  from: string;
  to: string;
  /** Camera ID or `all`. */
  cameraId: string;
  detection: DetectionFilter;
  onlyDetected: boolean;
  /** Only favorite events (at least one of their clips is marked). */
  favorites: boolean;
  /** Collection ID or `all`: only events in that collection (at least one of their clips). */
  collectionId: string;
}

export const DEFAULT_ARCHIVE_FILTERS: ArchiveFilters = {
  query: "",
  period: "all",
  from: "",
  to: "",
  cameraId: "all",
  detection: "all",
  onlyDetected: false,
  favorites: false,
  collectionId: "all",
};

const MAX_QUERY_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Detection types are identifiers like `licensePlate`; anything else is ignored. */
const DETECTION_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;

type ParamSource = Pick<URLSearchParams, "get"> | Record<string, string | string[] | undefined>;

function read(params: ParamSource, key: string): string | null {
  if (typeof (params as URLSearchParams).get === "function") return (params as URLSearchParams).get(key);
  const value = (params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Parses filters from URL params (or Next.js `searchParams`); invalid values fall back to defaults. */
export function parseArchiveFilters(params: ParamSource): ArchiveFilters {
  const period = read(params, "period");
  const detection = read(params, "type");
  const camera = read(params, "camera");
  const collection = read(params, "collection");
  const from = read(params, "from") ?? "";
  const to = read(params, "to") ?? "";
  return {
    query: normalizeQuery(read(params, "q") ?? ""),
    period: PERIODS.find((p) => p === period) ?? DEFAULT_ARCHIVE_FILTERS.period,
    from: isDayKey(from) ? from : "",
    to: isDayKey(to) ? to : "",
    cameraId: camera && UUID.test(camera) ? camera.toLowerCase() : "all",
    detection: detection === "none" || (detection && DETECTION_TYPE.test(detection)) ? detection : "all",
    onlyDetected: read(params, "detected") === "1",
    favorites: read(params, "fav") === "1",
    collectionId: collection && UUID.test(collection) ? collection.toLowerCase() : "all",
  };
}

/** Search text as used everywhere: Unicode NFC, trimmed, inner whitespace collapsed, limited. */
export function normalizeQuery(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Stable search aliases, independent of the selected UI locale and translation catalogs. */
const DETECTION_SEARCH_ALIASES = {
  person: ["person"],
  vehicle: ["vehicle", "fahrzeug"],
  animal: ["animal", "tier"],
  package: ["package", "paket"],
  face: ["face", "gesicht"],
  licensePlate: ["licence plate", "license plate", "kennzeichen"],
} as const;

/** Exact DE/EN labels or internal type names; no fuzzy matching or locale-dependent results. */
export function detectionTypesForQuery(query: string): string[] {
  const needle = normalizeQuery(query).toLocaleLowerCase("en");
  if (!needle) return [];
  return Object.entries(DETECTION_SEARCH_ALIASES)
    .filter(([type, aliases]) => type.toLocaleLowerCase("en") === needle || aliases.some((alias) => alias === needle))
    .map(([type]) => type);
}

export type CustomRangeIssue = "invalid-from" | "invalid-to" | "from-after-to";

export const CUSTOM_RANGE_MESSAGES: Record<CustomRangeIssue, string> = {
  "invalid-from": "Das Startdatum ist ungültig und wird ignoriert.",
  "invalid-to": "Das Enddatum ist ungültig und wird ignoriert.",
  "from-after-to": "Das Startdatum liegt nach dem Enddatum.",
};

/**
 * Problem with a custom range from the URL, so the UI can explain it instead of silently
 * swapping or dropping values. Invalid dates are ignored by the filter (open bound);
 * start after end matches nothing.
 */
export function customRangeIssue(params: ParamSource, filters: ArchiveFilters): CustomRangeIssue | undefined {
  if (filters.period !== "custom") return undefined;
  if ((read(params, "from") ?? "") !== "" && !filters.from) return "invalid-from";
  if ((read(params, "to") ?? "") !== "" && !filters.to) return "invalid-to";
  if (filters.from && filters.to && filters.from > filters.to) return "from-after-to";
  return undefined;
}

/** URL params for the filters, omitting defaults. */
export function serializeArchiveFilters(filters: ArchiveFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.period !== DEFAULT_ARCHIVE_FILTERS.period) params.set("period", filters.period);
  if (filters.period === "custom") {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  if (filters.cameraId !== "all") params.set("camera", filters.cameraId);
  if (filters.detection !== "all") params.set("type", filters.detection);
  if (filters.onlyDetected) params.set("detected", "1");
  if (filters.favorites) params.set("fav", "1");
  if (filters.collectionId !== "all") params.set("collection", filters.collectionId);
  return params;
}

/**
 * Number of filters set in the mobile filter sheet (badge on its button). Favorites and the
 * collection are not counted: they have a visible row of their own.
 */
export function countRefinements(filters: ArchiveFilters): number {
  return [filters.cameraId !== "all", filters.detection !== "all", filters.onlyDetected].filter(Boolean).length;
}

export function isFiltered(filters: ArchiveFilters): boolean {
  return serializeArchiveFilters(filters).toString() !== "";
}

/** `/archive` with the given filters. */
export function archiveHref(filters: ArchiveFilters): string {
  const query = serializeArchiveFilters(filters).toString();
  return query ? `/archive?${query}` : "/archive";
}

/**
 * "Back to archive" target from an untrusted `from` value (the archive query string the user
 * came from). Only known filter params are taken over and the path is always `/archive`, so it
 * can never point anywhere else (no open redirect).
 */
export function archiveReturnHref(from: string | undefined | null): string {
  if (!from) return "/archive";
  try {
    return archiveHref(parseArchiveFilters(new URLSearchParams(from.startsWith("?") ? from.slice(1) : from)));
  } catch {
    return "/archive";
  }
}

/** Link to an event's detail page that remembers the archive filters. */
export function eventHref(eventId: string, filters?: ArchiveFilters): string {
  const query = filters ? serializeArchiveFilters(filters).toString() : "";
  return query ? `/archive/${eventId}?from=${encodeURIComponent(query)}` : `/archive/${eventId}`;
}
