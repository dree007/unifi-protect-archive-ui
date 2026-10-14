import type de from "./messages/de.json";

export const LOCALES = ["de", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof de;
export type Messages = { [K in MessageKey]: string | { one: string; other: string } };
export type Parameters = Record<string, string | number>;
export type Translator = (key: MessageKey, parameters?: Parameters) => string;
export const LOCALE_COOKIE = "ui_locale";
export const LOCALE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return value === "de" || value === "en";
}

/** Supported preferences only; q=0 explicitly excludes a language. */
export function detectLocale(cookie: unknown, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const preferences = (acceptLanguage ?? "").slice(0, 4096).split(",").flatMap((part, index) => {
    const match = /^\s*([a-z]{2,8}(?:-[a-z0-9]{1,8})*|\*)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    if (!match) return [];
    const locale = match[1].split("-")[0].toLowerCase();
    const quality = match[2] === undefined ? 1 : Number(match[2]);
    return isLocale(locale) && quality > 0 ? [{ locale, quality, index }] : [];
  });
  preferences.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return preferences[0]?.locale ?? "en";
}

export const intlLocale = (locale: Locale) => locale === "de" ? "de-DE" : "en-GB";

export function createTranslator(locale: Locale, messages: Messages): Translator {
  const number = new Intl.NumberFormat(intlLocale(locale));
  const plural = new Intl.PluralRules(intlLocale(locale));
  return (key, parameters = {}) => {
    const message = messages[key];
    if (message === undefined) throw new Error(`Missing translation: ${key}`);
    if (typeof message !== "string" && (typeof parameters.count !== "number" || !Number.isFinite(parameters.count))) throw new Error(`Missing plural count: ${key}`);
    const template = typeof message === "string" ? message : message[plural.select(Number(parameters.count)) === "one" ? "one" : "other"];
    return template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
      const value = parameters[name];
      if (value === undefined) throw new Error(`Missing translation parameter: ${key}.${name}`);
      return typeof value === "number" ? number.format(value) : value;
    });
  };
}
