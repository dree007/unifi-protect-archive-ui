"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUpRight, CalendarX, Loader2, SearchX } from "lucide-react";

import { loadEventDetail, loadMoreArchiveEvents } from "@/app/archive/actions";
import { EventDetailSkeleton } from "@/components/archive/archive-skeleton";
import { FilterBar } from "@/components/archive/filter-bar";
import { EmptyState } from "@/components/common/empty-state";
import { EventDetail } from "@/components/events/event-detail";
import { EventTimeline } from "@/components/events/event-timeline";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  archiveHref,
  DEFAULT_ARCHIVE_FILTERS,
  eventHref,
  isFiltered,
  normalizeQuery,
  serializeArchiveFilters,
  type ArchiveFilters,
  type CustomRangeIssue,
} from "@/lib/archive-filters";
import type { ArchivePageModel, EventCardModel, EventDetailModel, FilterOption } from "@/lib/view-models";

/** From this width on, the selected event opens in a side panel instead of a separate page. */
const SIDE_PANEL_QUERY = "(min-width: 80rem)";
const SEARCH_DEBOUNCE_MS = 350;

interface ArchiveBrowserProps {
  filters: ArchiveFilters;
  firstPage: ArchivePageModel;
  cameras: FilterOption[];
  detectionTypes: string[];
  /** Problem with a custom range from the URL (shown next to the date fields). */
  rangeIssue?: CustomRangeIssue;
}

/**
 * Filters live in the URL; changing them navigates (the server renders the first page). The
 * search box keeps its own state so typing is not interrupted by the navigation.
 *
 * History: every filter change is a new entry (Back returns to the previous filters); while
 * refining a search, debounced updates replace the entry instead of adding one per pause.
 */
export function ArchiveBrowser({ filters, firstPage, cameras, detectionTypes, rangeIssue }: ArchiveBrowserProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.query);
  /** Typed text not yet applied (debounce running). */
  const [typing, setTyping] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The filters of the latest render: a debounced search must not navigate with filters that
  // changed in the meantime (e.g. a period clicked right after typing).
  const latestFilters = useRef(filters);
  useEffect(() => {
    latestFilters.current = filters;
  }, [filters]);

  // Back/forward (or a reset elsewhere) changes the URL query: show it, unless the user is typing.
  const [shownQuery, setShownQuery] = useState(filters.query);
  if (shownQuery !== filters.query) {
    setShownQuery(filters.query);
    if (!typing) setSearch(filters.query);
  }

  const cancelDebounce = () => {
    clearTimeout(debounce.current);
    setTyping(false);
  };
  const navigate = (next: ArchiveFilters, mode: "push" | "replace" = "push") => {
    const href = archiveHref(next);
    startTransition(() => (mode === "push" ? router.push(href, { scroll: false }) : router.replace(href, { scroll: false })));
  };
  const updateFilters = (patch: Partial<ArchiveFilters>) => {
    cancelDebounce();
    const next = { ...latestFilters.current, ...patch, query: normalizeQuery(search) };
    // Keep rapid edits coherent while the previous server navigation is still pending.
    latestFilters.current = next;
    navigate(next);
  };
  const resetFilters = () => {
    cancelDebounce();
    setSearch("");
    navigate(DEFAULT_ARCHIVE_FILTERS);
  };
  const applySearch = (value: string) => {
    cancelDebounce();
    const current = latestFilters.current;
    const query = normalizeQuery(value);
    if (query === current.query) return;
    // Refining an existing search replaces the history entry; starting or clearing one adds an entry.
    navigate({ ...current, query }, current.query && query ? "replace" : "push");
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    setTyping(true);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => applySearch(value), SEARCH_DEBOUNCE_MS);
  };
  useEffect(() => () => clearTimeout(debounce.current), []);

  const filterQuery = serializeArchiveFilters(filters).toString();

  return (
    <div className="flex flex-col gap-6">
      <FilterBar
        filters={filters}
        search={search}
        onSearchChange={changeSearch}
        onSearchSubmit={() => applySearch(search)}
        cameras={cameras}
        detectionTypes={detectionTypes}
        rangeIssue={rangeIssue}
        onChange={updateFilters}
        onReset={resetFilters}
      />
      <div aria-busy={isPending} className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {/* New filters → new first page: remount resets loaded pages and selection. */}
        <ArchiveResults key={filterQuery} filters={filters} firstPage={firstPage} rangeIssue={rangeIssue} onReset={resetFilters} />
      </div>
    </div>
  );
}

function ArchiveResults({
  filters,
  firstPage,
  rangeIssue,
  onReset,
}: {
  filters: ArchiveFilters;
  firstPage: ArchivePageModel;
  rangeIssue?: CustomRangeIssue;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const [events, setEvents] = useState<EventCardModel[]>(firstPage.events);
  const [nextCursor, setNextCursor] = useState(firstPage.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const hasSidePanel = useMediaQuery(SIDE_PANEL_QUERY);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = hasSidePanel ? (events.find((event) => event.id === selectedId) ?? events[0]) : undefined;

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const page = await loadMoreArchiveEvents(serializeArchiveFilters(filters).toString(), nextCursor);
      setEvents((current) => {
        const known = new Set(current.map((event) => event.id));
        return [...current, ...page.events.filter((event) => !known.has(event.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (events.length === 0) {
    if (rangeIssue === "from-after-to") {
      return (
        <EmptyState
          icon={CalendarX}
          title={t("errors.fromAfterTo")}
          description={t("errors.rangeHint")}
          action={<Button variant="outline" onClick={onReset}>{t("filters.reset")}</Button>}
        />
      );
    }
    return filters.query ? (
      <EmptyState
        icon={SearchX}
        title={t("archive.noMatches", { query: filters.query })}
        description={t("archive.noMatchesBody")}
        action={<Button variant="outline" onClick={onReset}>{t("filters.reset")}</Button>}
      />
    ) : (
      <EmptyState
        icon={CalendarX}
        title={t("archive.noEvents")}
        description={isFiltered(filters) ? t("archive.adjustFilters") : undefined}
        action={isFiltered(filters) ? <Button variant="outline" onClick={onReset}>{t("filters.reset")}</Button> : undefined}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="flex flex-col gap-5">
        <EventTimeline
          events={events}
          hrefFor={(event) => eventHref(event.id, filters)}
          selectedId={selected?.id}
          onEventClick={(event, mouseEvent) => {
            if (!hasSidePanel || mouseEvent.metaKey || mouseEvent.ctrlKey || mouseEvent.shiftKey) return;
            mouseEvent.preventDefault();
            setSelectedId(event.id);
          }}
          // Columns follow the list width next to the side panel (xl+): ≥ ~300 px per card.
          listClassName="md:grid-cols-2 xl:grid-cols-1 min-[90rem]:grid-cols-2 min-[112rem]:grid-cols-3"
        />
        <div className="flex flex-col items-center gap-2 pt-1" aria-live="polite">
          {nextCursor ? (
            <Button variant="outline" size="lg" onClick={loadMore} disabled={loadingMore} className="min-w-44 border-transparent bg-card shadow-[var(--shadow-card)]">
              {loadingMore && <Loader2 aria-hidden className="animate-spin" />}
              {loadingMore ? t("common.loadingMore") : t("archive.more")}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("counts.events", { count: events.length })} ·{" "}
              {isFiltered(filters) ? t("archive.noMore") : t("archive.end")}
            </p>
          )}
          {loadError && <p className="text-sm text-danger-strong">{t("errors.loadMore")}</p>}
        </div>
      </div>

      {selected && <DetailPanel key={selected.id} event={selected} filters={filters} />}
    </div>
  );
}

/** Desktop side panel: loads the details of the selected event on demand. */
function DetailPanel({ event, filters }: { event: EventCardModel; filters: ArchiveFilters }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<EventDetailModel | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    loadEventDetail(event.id).then(
      (result) => active && setDetail(result),
      () => active && setDetail(null),
    );
    return () => {
      active = false;
    };
  }, [event.id]);

  return (
    <aside
      aria-label={t("events.details")}
      className="surface-card sticky top-10 hidden max-h-[calc(100dvh-5rem)] overflow-y-auto p-5 xl:block"
    >
      {detail === undefined ? (
        <EventDetailSkeleton />
      ) : detail === null ? (
        <p className="text-sm text-muted-foreground">{t("errors.detail")}</p>
      ) : (
        <EventDetail
          event={detail}
          variant="panel"
          actions={
            <Button asChild variant="secondary" size="icon" aria-label={t("archive.openDetail")}>
              <Link href={eventHref(event.id, filters)}>
                <ArrowUpRight aria-hidden />
              </Link>
            </Button>
          }
        />
      )}
    </aside>
  );
}
