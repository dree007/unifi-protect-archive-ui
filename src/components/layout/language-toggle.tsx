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
      <div role="group" aria-label={t("navigation.language")} aria-busy={pending} className="flex rounded-full border border-border bg-card p-1 shadow-[var(--shadow-control)]">
        {LOCALES.map((option) => (
          <button key={option} type="button" aria-label={option === "de" ? "Deutsch" : "English"} aria-pressed={option === locale} disabled={pending}
            onClick={() => { if (option === locale) return; setFailed(false); startTransition(async () => { try { await setLocale(option); } catch { setFailed(true); } }); }}
            className={cn("min-h-11 min-w-11 rounded-full px-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-70", option === locale ? "surface-selected font-bold underline underline-offset-4" : "font-medium text-muted-foreground hover:bg-muted")}>
            {option.toUpperCase()}
          </button>
        ))}
      </div>
      {failed && <p role="alert" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl bg-card p-3 text-sm shadow-lg">{t("errors.language")}</p>}
    </div>
  );
}
