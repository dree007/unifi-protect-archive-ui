"use client";

import { localizeEvent } from "@/i18n/event-format";
import { useI18n } from "@/i18n/provider";
import type { MouseEvent } from "react";
import { cn } from "cn";

import { EventCard } from "@/components/events/event-card";
import type { EventCardModel } from "@/lib/view-models";

interface EventTimelineProps {
  /** Events sorted newest first. */
  events: readonly EventCardModel[];
  hrefFor: (event: EventCardModel) => string;
  selectedId?: string;
  onEventClick?: (event: EventCardModel, mouseEvent: MouseEvent<HTMLAnchorElement>) => void;
  listClassName?: string;
}

function groupByDay(events: readonly EventCardModel[]): EventCardModel[][] {
  const groups: EventCardModel[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (current && current[0].dayKey === event.dayKey) current.push(event);
    else groups.push([event]);
  }
  return groups;
}

/** Events grouped by calendar day (app time zone) under quiet day headings. */
export function EventTimeline({ events, hrefFor, selectedId, onEventClick, listClassName }: EventTimelineProps) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-7">
      {groupByDay(events.map((event) => localizeEvent(event, locale))).map((dayEvents) => {
        const first = dayEvents[0];
        const headingId = `day-${first.dayKey}`;
        const relative = first.dayLabel === t("common.today") || first.dayLabel === t("common.yesterday");
        return (
          <section key={first.dayKey} aria-labelledby={headingId} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2 px-1">
              <h2 id={headingId} className="text-[0.9375rem] font-semibold tracking-tight">
                {first.dayLabel}
              </h2>
              {relative && <span className="text-sm text-muted-foreground">{first.dateLabel}</span>}
            </div>
            <ol className={cn("grid grid-cols-1 gap-3", listClassName)}>
              {dayEvents.map((event) => (
                <li key={event.id}>
                  <EventCard
                    event={event}
                    href={hrefFor(event)}
                    selected={event.id === selectedId}
                    onClick={onEventClick ? (e) => onEventClick(event, e) : undefined}
                    className="h-full"
                  />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
