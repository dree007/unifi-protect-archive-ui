"use client";

import { useState, useTransition } from "react";
import { cn } from "cn";
import { setLocale } from "@/i18n/actions";
import { LOCALES } from "@/i18n/core";
import { useI18n } from "@/i18n/provider";

export function LanguageToggle() {
  const { locale, t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative shrink-0">
      <div role="group" aria-label={t("navigation.language")} aria-busy={pending} className="surface-track flex p-1">
        {LOCALES.map((option) => (
          <button key={option} type="button" aria-label={option === "de" ? "Deutsch" : "English"} aria-pressed={option === locale} disabled={pending}
            onClick={() => { if (option === locale) return; setFailed(false); startTransition(async () => { try { await setLocale(option); } catch { setFailed(true); } }); }}
            className={cn("min-h-11 min-w-11 rounded-full px-2 text-xs font-medium outline-none transition-[background-color,box-shadow,color] duration-200 focus-ring disabled:opacity-70", option === locale ? "surface-control underline underline-offset-4" : "text-graphite hover:text-foreground")}>
            {option.toUpperCase()}
          </button>
        ))}
      </div>
      {failed && <p role="alert" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md bg-popover p-3 text-sm shadow-soft-md">{t("errors.language")}</p>}
    </div>
  );
}
