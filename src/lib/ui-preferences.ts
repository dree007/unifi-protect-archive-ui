/**
 * Display preferences kept in plain cookies, so the server renders the chosen theme and sidebar
 * width on the first paint (no flash). Written by the browser; nothing else depends on them.
 */
export const THEME_COOKIE = "ui_theme";
export const SIDEBAR_COOKIE = "ui_sidebar";
const MAX_AGE = 60 * 60 * 24 * 365;

export type Theme = "light" | "dark";

/** An explicit choice, or `null` to follow the system preference. */
export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function parseSidebarCollapsed(value: unknown): boolean {
  return value === "collapsed";
}

export function writePreference(name: typeof THEME_COOKIE | typeof SIDEBAR_COOKIE, value: string) {
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${name}=${value}; path=/; max-age=${MAX_AGE}; samesite=lax${secure}`;
}
