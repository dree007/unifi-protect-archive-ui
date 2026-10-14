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
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "common.dashboard", icon: LayoutDashboard },
  { href: "/archive", label: "common.archive", icon: Archive },
  { href: "/cameras", label: "common.cameras", icon: Cctv },
  { href: "/system", label: "common.system", icon: Server },
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Vertical navigation in the desktop sidebar. */
export function SidebarNavigation() {
  const { t } = useI18n();
  const isActive = useIsActive();
  return (
    <nav aria-label={t("navigation.main")}>
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-12 items-center gap-3 rounded-[var(--radius-control)] px-4 text-[0.9375rem] font-medium text-muted-foreground transition-colors duration-200 outline-none",
                  "hover:bg-card/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring",
                  active && "surface-selected font-semibold hover:bg-selected hover:text-selected-foreground",
                )}
              >
                <Icon aria-hidden className="size-5" />
                {t(label)}
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
      className="fixed inset-x-0 bottom-0 z-40 rounded-t-[1.5rem] bg-card/90 pb-safe shadow-[0_-10px_30px_-16px_rgb(37_48_71/0.22)] backdrop-blur-lg lg:hidden"
    >
      <ul className="mx-auto grid max-w-md grid-cols-4 px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex h-15 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-medium text-muted-foreground outline-none",
                  "focus-visible:ring-3 focus-visible:ring-ring",
                  active && "font-semibold text-selected-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid h-8 w-14 place-items-center rounded-full transition-colors duration-200",
                    active ? "bg-selected" : "group-hover:bg-muted",
                  )}
                >
                  <Icon aria-hidden className="size-5" />
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
