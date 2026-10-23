"use client";

import { useI18n } from "@/i18n/provider";
import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react";
import { cn } from "cn";

import { LanguageToggle } from "@/components/layout/language-toggle";
import { AppLogo } from "@/components/layout/app-logo";
import { MobileNavigation, SidebarNavigation } from "@/components/layout/navigation";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { signOut } from "@/app/login/actions";
import { SIDEBAR_COOKIE, writePreference, type Theme } from "@/lib/ui-preferences";

interface AppShellProps {
  children: ReactNode;
  version: string;
  sourceUrl: string | null;
  theme: Theme | null;
  sidebarCollapsed: boolean;
  /** Built-in login active: show "Sign out". */
  loginEnabled: boolean;
}

/**
 * Responsive app frame: calm sidebar on desktop (lg+) that folds to an icon rail, compact top
 * bar plus bottom tab bar on mobile.
 */
export function AppShell({ children, version, sourceUrl, theme, sidebarCollapsed, loginEnabled }: AppShellProps) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(sidebarCollapsed);
  const toggleSidebar = () => {
    writePreference(SIDEBAR_COOKIE, collapsed ? "expanded" : "collapsed");
    setCollapsed(!collapsed);
  };
  // The login page stands alone, without navigation.
  if (pathname === "/login") return children;
  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-card px-4 py-2 shadow-soft-md focus-ring focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("navigation.skip")}
      </a>

      <aside
        id="sidebar"
        className={cn(
          "hidden lg:sticky lg:top-0 lg:z-20 lg:flex lg:h-dvh lg:shrink-0 lg:flex-col lg:gap-8 lg:bg-surface-muted lg:py-8 lg:transition-[width] lg:duration-200",
          collapsed ? "lg:w-24 lg:px-3" : "lg:w-72 lg:px-5",
        )}
      >
        <div className={cn(collapsed ? "flex justify-center" : "px-2")}>
          <AppLogo collapsed={collapsed} />
        </div>
        {/* The small slider on the sidebar edge: folds the sidebar to its icons and back. */}
        <button
          type="button"
          aria-controls="sidebar"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("navigation.expand") : t("navigation.collapse")}
          title={collapsed ? t("navigation.expand") : t("navigation.collapse")}
          onClick={toggleSidebar}
          className="surface-control absolute top-[2.125rem] -right-3 grid h-10 w-6 place-items-center rounded-full text-graphite outline-none focus-ring after:absolute after:-inset-x-2 hover:text-foreground"
        >
          {collapsed ? <ChevronRight aria-hidden className="size-4" /> : <ChevronLeft aria-hidden className="size-4" />}
        </button>
        <SidebarNavigation collapsed={collapsed} />
        <div className={cn("mt-auto flex flex-col gap-3", collapsed ? "items-center" : "px-2")}>
          {loginEnabled && (
            <form action={signOut}>
              <button
                type="submit"
                title={collapsed ? t("navigation.signOut") : undefined}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-full text-[0.9375rem] text-graphite outline-none transition-[background-color,color] duration-200 hover:bg-eggshell/70 hover:text-foreground focus-ring",
                  collapsed ? "w-11 justify-center" : "w-full px-3",
                )}
              >
                <LogOut aria-hidden className="size-5 shrink-0 text-rose-ink" />
                <span className={cn(collapsed && "sr-only")}>{t("navigation.signOut")}</span>
              </button>
            </form>
          )}
          <div className={cn("flex gap-3", collapsed ? "flex-col items-center" : "items-center justify-between")}>
            <ThemeToggle theme={theme} />
            <LanguageToggle orientation={collapsed ? "vertical" : "horizontal"} />
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex min-h-18 items-center justify-between gap-2 border-b border-line bg-background px-4 lg:hidden">
        <AppLogo compact />
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle theme={theme} variant="compact" />
          <LanguageToggle />
        </div>
      </header>

      <main id="main" className="min-w-0 flex-1 pb-28 lg:pb-12">
        <div className="mx-auto w-full max-w-[90rem] px-4 pt-4 sm:px-6 lg:px-10 lg:pt-10">{children}</div>
        <footer className="mx-auto mt-10 flex w-full max-w-[90rem] flex-col gap-2 px-4 text-xs text-muted-foreground sm:px-6 lg:px-10">
          <p>{t("legal.version", { version })} · {t("legal.notice")}</p>
          <nav aria-label={t("legal.links")} className="flex flex-wrap items-center gap-x-4 gap-y-2 pointer-coarse:gap-y-0">
            <a className="inline-flex items-center rounded-xs underline underline-offset-4 focus-ring pointer-coarse:min-h-11" href="/notices/LICENSE.txt">{t("legal.license")}</a>
            <a className="inline-flex items-center rounded-xs underline underline-offset-4 focus-ring pointer-coarse:min-h-11" href="/notices/THIRD_PARTY_NOTICES.md">{t("legal.thirdParty")}</a>
            {sourceUrl ? (
              <a className="inline-flex items-center rounded-xs underline underline-offset-4 focus-ring pointer-coarse:min-h-11" href={sourceUrl} target="_blank" rel="noopener noreferrer">{t("legal.source")}</a>
            ) : <span>{t("legal.sourcePending")}</span>}
            {loginEnabled && (
              <form action={signOut} className="lg:hidden">
                <button type="submit" className="inline-flex items-center gap-1.5 rounded-xs underline underline-offset-4 focus-ring pointer-coarse:min-h-11">
                  <LogOut aria-hidden className="size-3.5" />{t("navigation.signOut")}
                </button>
              </form>
            )}
          </nav>
        </footer>
      </main>

      <MobileNavigation />
    </div>
  );
}
