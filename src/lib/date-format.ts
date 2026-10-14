import { intlLocale, type Locale } from "@/i18n/core";
import { addDays, dayKeyInZone, type DayKey } from "./time-zone";

/**
 * Locale-aware date/time formatting in an explicit time zone (APP_TIME_ZONE). Used on the server
 * when building view models, so the browser's time zone never matters.
 */
export interface DateFormat {
  timeZone: string;
  locale: Locale;
  /** "07:42" */
  time(instant: Date): string;
  /** "07:42:13" */
  timeWithSeconds(instant: Date): string;
  /** "06.10.2026, 07:42:13" */
  dateTime(instant: Date): string;
  /** "06.10." */
  shortDate(instant: Date): string;
  /** "06.10.2026" */
  date(instant: Date): string;
  dayKey(instant: Date): DayKey;
  /** "Heute", "Gestern" or "Sonntag, 4. Oktober" (with year if not the current one). */
  dayLabel(instant: Date, now: Date): string;
  /** "07:42", "Gestern, 21:14" or "04.10., 16:40". */
  eventTime(instant: Date, now: Date): string;
}


const cache = new Map<string, DateFormat>();

export function createDateFormat(timeZone: string, locale: Locale = "de"): DateFormat {
  const cached = cache.get(`${timeZone}:${locale}`);
  if (cached) return cached;

  const make = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(intlLocale(locale), { timeZone, ...options });
  const time = make({ hour: "2-digit", minute: "2-digit" });
  const timeWithSeconds = make({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateTime = make({ day: "2-digit", month: locale === "de" ? "2-digit" : "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const shortDate = make({ day: "2-digit", month: locale === "de" ? "2-digit" : "short" });
  const date = make({ day: "2-digit", month: locale === "de" ? "2-digit" : "short", year: "numeric" });
  const longDate = make({ weekday: "long", day: "numeric", month: "long" });
  const longDateWithYear = make({ weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const format: DateFormat = {
    timeZone,
    locale,
    time: (instant) => time.format(instant),
    timeWithSeconds: (instant) => timeWithSeconds.format(instant),
    dateTime: (instant) => dateTime.format(instant),
    shortDate: (instant) => shortDate.format(instant),
    date: (instant) => date.format(instant),
    dayKey: (instant) => dayKeyInZone(instant, timeZone),
    dayLabel(instant, now) {
      const day = dayKeyInZone(instant, timeZone);
      const today = dayKeyInZone(now, timeZone);
      if (day === today) return locale === "de" ? "Heute" : "Today";
      if (day === addDays(today, -1)) return locale === "de" ? "Gestern" : "Yesterday";
      return day.slice(0, 4) === today.slice(0, 4) ? longDate.format(instant) : longDateWithYear.format(instant);
    },
    eventTime(instant, now) {
      const day = dayKeyInZone(instant, timeZone);
      const today = dayKeyInZone(now, timeZone);
      if (day === today) return time.format(instant);
      if (day === addDays(today, -1)) return `${locale === "de" ? "Gestern" : "Yesterday"}, ${time.format(instant)}`;
      return `${shortDate.format(instant)}, ${time.format(instant)}`;
    },
  };
  cache.set(`${timeZone}:${locale}`, format);
  return format;
}
