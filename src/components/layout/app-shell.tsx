"use client";

import { useI18n } from "@/i18n/provider";
import type { ReactNode } from "react";

import { LanguageToggle } from "@/components/layout/language-toggle";
import { AppLogo } from "@/components/layout/app-logo";
import { MobileNavigation, SidebarNavigation } from "@/components/layout/navigation";

/**
 * Responsive app frame: calm sidebar on desktop (lg+), compact top bar plus bottom tab bar
 * on mobile.
 */
export function AppShell({ children, version, sourceUrl }: { children: ReactNode; version: string; sourceUrl: string | null }) {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main"
        className="sr-only z-50 rounded-[var(--radius-control)] bg-card px-4 py-2 shadow-[var(--shadow-elevated)] focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("navigation.skip")}
      </a>

      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-72 lg:shrink-0 lg:flex-col lg:gap-8 lg:bg-surface-muted/60 lg:px-5 lg:py-8">
        <div className="px-2">
          <AppLogo />
        </div>
        <SidebarNavigation />
        <div className="mt-auto flex justify-end px-2"><LanguageToggle /></div>
      </aside>

      <header className="sticky top-0 z-30 flex min-h-18 items-center justify-between gap-2 bg-background/85 px-4 backdrop-blur-lg lg:hidden">
        <AppLogo compact />
        <LanguageToggle />
      </header>

      <main id="main" className="min-w-0 flex-1 pb-28 lg:pb-12">
        <div className="mx-auto w-full max-w-[90rem] px-4 pt-4 sm:px-6 lg:px-10 lg:pt-10">{children}</div>
        <footer className="mx-auto mt-10 flex w-full max-w-[90rem] flex-col gap-2 px-4 text-xs text-muted-foreground sm:px-6 lg:px-10">
          <p>{t("legal.version", { version })} · {t("legal.notice")}</p>
          <nav aria-label={t("legal.links")} className="flex flex-wrap gap-x-4 gap-y-2">
            <a className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" href="/notices/LICENSE.txt">{t("legal.license")}</a>
            <a className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" href="/notices/THIRD_PARTY_NOTICES.md">{t("legal.thirdParty")}</a>
            {sourceUrl ? (
              <a className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" href={sourceUrl} target="_blank" rel="noopener noreferrer">{t("legal.source")}</a>
            ) : <span>{t("legal.sourcePending")}</span>}
          </nav>
        </footer>
      </main>

      <MobileNavigation />
    </div>
  );
}
