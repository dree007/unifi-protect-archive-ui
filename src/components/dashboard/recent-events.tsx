"use client";

import { useI18n } from "@/i18n/provider";

import { EventCard } from "@/components/events/event-card";
import { useShownEvents } from "@/hooks/use-shown-events";
import { eventHref } from "@/lib/archive-filters";
import type { EventCardModel } from "@/lib/view-models";

/** Newest events on the dashboard; pending ones leave when their grace period ends. */
export function RecentEvents({ events }: { events: readonly EventCardModel[] }) {
  const { t } = useI18n();
  const shown = useShownEvents(events);
  if (shown.length === 0) return <p className="surface-card p-5 text-sm text-muted-foreground">{t("dashboard.noEvents")}</p>;
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {shown.map((event) => (
        <li key={event.id}>
          <EventCard event={event} href={eventHref(event.id)} showDate className="h-full" />
        </li>
      ))}
    </ul>
  );
}
