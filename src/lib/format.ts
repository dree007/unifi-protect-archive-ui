import { intlLocale, type Locale } from "@/i18n/core";
/**
 * Locale-aware formatting helpers that do not depend on a time zone (durations, sizes, counts,
 * relative times). Calendar dates and clock times: see date-format.ts.
 */

/** "vor 2 Minuten", "vor 42 Sekunden", "vor 3 Tagen", "gestern". */
export function formatRelative(instant: Date, now: Date, locale: Locale = "de"): string {
  const relativeFormat = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
  const seconds = Math.round((instant.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relativeFormat.format(seconds, "second");
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 60) return relativeFormat.format(Math.round(seconds / 86400), "day");
  return relativeFormat.format(Math.round(seconds / (86400 * 30)), "month");
}

/** Compact duration: "18 Sek.", "1:03 Min.", "1:02:05 Std." */
export function formatDuration(totalSeconds: number, locale: Locale = "de"): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} ${locale === "de" ? "Sek." : "sec"}`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} ${locale === "de" ? "Min." : "min"}`;
  const minutes = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${minutes}:${String(s % 60).padStart(2, "0")} ${locale === "de" ? "Std." : "hr"}`;
}

/** Spelled-out duration: "18 Sekunden", "1:03 Minuten", "1:02:05 Stunden". */
export function formatDurationLong(totalSeconds: number, locale: Locale = "de"): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const unit = s < 60 ? "second" : s < 3600 ? "minute" : "hour";
  const quantity = s / (unit === "second" ? 1 : unit === "minute" ? 60 : 3600);
  const name = new Intl.NumberFormat(intlLocale(locale), { style: "unit", unit, unitDisplay: "long" }).formatToParts(quantity).find((part) => part.type === "unit")!.value;
  const clock = formatDuration(s, locale).split(" ")[0];
  return `${clock} ${name}`;
}

export function formatNumber(value: number, locale: Locale = "de"): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Decimal byte units, as storage vendors use them: "1,82 TB", "38,4 MB". */
export function formatBytes(bytes: number, locale: Locale = "de"): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString(intlLocale(locale), { maximumFractionDigits: digits })} ${BYTE_UNITS[unit]}`;
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
