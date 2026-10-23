"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, Cctv, LayoutDashboard, type LucideIcon, Server } from "lucide-react";
import { cn } from "cn";

interface NavItem {
  href: string;
  label: import("@/i18n/core").MessageKey;
  icon: LucideIcon;
  /** Pastel ink of the icon; the label stays graphite/ink. */
  hue: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "common.dashboard", icon: LayoutDashboard, hue: "text-violet-ink" },
  { href: "/archive", label: "common.archive", icon: Archive, hue: "text-butter-ink" },
  { href: "/cameras", label: "common.cameras", icon: Cctv, hue: "text-sky-ink" },
  { href: "/system", label: "common.system", icon: Server, hue: "text-sage-ink" },
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Vertical navigation in the desktop sidebar; `collapsed` shows only the icons. */
export function SidebarNavigation({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  const isActive = useIsActive();
  return (
    <nav aria-label={t("navigation.main")}>
      <ul className={cn("flex flex-col gap-1", collapsed && "items-center")}>
        {NAV_ITEMS.map(({ href, label, icon: Icon, hue }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? t(label) : undefined}
                className={cn(
                  "flex h-12 items-center gap-3 overflow-hidden rounded-full text-[0.9375rem] whitespace-nowrap transition-[background-color,box-shadow,color] duration-200 outline-none focus-ring",
                  collapsed ? "w-12 justify-center" : "px-4",
                  // Active: the raised pill on the warm-taupe band (TabPills pattern).
                  active ? "surface-control font-medium" : "text-graphite hover:bg-eggshell/70 hover:text-foreground",
                )}
              >
                <Icon aria-hidden className={cn("size-5 shrink-0", hue)} />
                <span className={cn(collapsed && "sr-only")}>{t(label)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Fixed bottom tab bar on mobile. */
export function MobileNavigation() {
  const { t } = useI18n();
  const isActive = useIsActive();
  return (
    <nav
      aria-label={t("navigation.main")}
      className="fixed inset-x-0 bottom-0 z-40 rounded-t-card border-t border-line bg-surface-muted pb-safe lg:hidden"
    >
      <ul className="mx-auto grid max-w-md grid-cols-4 px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon, hue }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex h-15 flex-col items-center justify-center gap-0.5 rounded-md text-xs font-medium text-graphite outline-none",
                  "focus-ring",
                  active && "text-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid h-8 w-14 place-items-center rounded-full transition-[background-color,box-shadow] duration-200",
                    active ? "surface-control" : "group-hover:bg-eggshell/70",
                  )}
                >
                  <Icon aria-hidden className={cn("size-5", hue)} />
                </span>
                {t(label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
