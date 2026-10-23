"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "cn";
import { useI18n } from "@/i18n/provider";
import { THEME_COOKIE, writePreference, type Theme } from "@/lib/ui-preferences";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = matchMedia(DARK_QUERY);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

/** The theme in effect: the explicit class on <html>, otherwise the system preference. */
function isDark() {
  const { classList } = document.documentElement;
  if (classList.contains("dark")) return true;
  if (classList.contains("light")) return false;
  return matchMedia(DARK_QUERY).matches;
}

function applyTheme(theme: Theme) {
  writePreference(THEME_COOKIE, theme);
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(theme);
}

/**
 * Light/dark switch. `slider` is the sun–moon track of the sidebar; `compact` a single round
 * button for the narrow mobile top bar. Both are one switch with the same accessible name.
 */
export function ThemeToggle({ theme, variant = "slider" }: { theme: Theme | null; variant?: "slider" | "compact" }) {
  const { t } = useI18n();
  // Without a cookie the server cannot know the system preference; it renders light first.
  const dark = useSyncExternalStore(subscribe, isDark, () => theme === "dark");
  const toggle = () => applyTheme(dark ? "light" : "dark");

  if (variant === "compact") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label={t("navigation.darkMode")}
        onClick={toggle}
        className="surface-control grid size-11 shrink-0 place-items-center rounded-full outline-none focus-ring"
      >
        {dark ? <Moon aria-hidden className="size-5 text-violet-ink" /> : <Sun aria-hidden className="size-5 text-butter-ink" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={t("navigation.darkMode")}
      title={t("navigation.darkMode")}
      onClick={toggle}
      className="surface-track relative inline-flex h-11 w-[4.5rem] shrink-0 items-center outline-none focus-ring"
    >
      <Sun aria-hidden className="absolute left-3.5 size-4 text-ash" />
      <Moon aria-hidden className="absolute right-3.5 size-4 text-ash" />
      <span
        aria-hidden
        className={cn(
          "surface-control absolute top-1 left-1 grid size-9 place-items-center rounded-full transition-transform duration-200",
          dark && "translate-x-[1.75rem]",
        )}
      >
        {dark ? <Moon className="size-4.5 text-violet-ink" /> : <Sun className="size-4.5 text-butter-ink" />}
      </span>
    </button>
  );
}
