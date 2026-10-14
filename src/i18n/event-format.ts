import { createDateFormat } from "@/lib/date-format";
import type { EventCardModel, EventDetailModel } from "@/lib/view-models";
import type { Locale } from "./core";

export function localizeEvent<T extends EventCardModel>(event: T, locale: Locale): T {
  if (!event.presentation) return event;
  const { start, end, now, timeZone } = event.presentation;
  const format = createDateFormat(timeZone, locale);
  const date = new Date(start);
  return {
    ...event,
    dayLabel: format.dayLabel(date, new Date(now)),
    dateLabel: format.date(date),
    timeLabel: format.time(date),
    whenLabel: format.eventTime(date, new Date(now)),
    ...("startLabel" in event ? { startLabel: format.dateTime(date), endLabel: end ? format.dateTime(new Date(end)) : null } satisfies Pick<EventDetailModel, "startLabel" | "endLabel"> : {}),
  };
}
