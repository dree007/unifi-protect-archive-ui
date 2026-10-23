"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { LogoMark } from "@/components/layout/logo-mark";
import { cn } from "cn";

/** `compact`: the mobile top bar; `collapsed`: the folded sidebar, mark only. */
export function AppLogo({ compact = false, collapsed = false }: { compact?: boolean; collapsed?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      href="/"
      aria-label={collapsed ? "Protect Archive UI" : undefined}
      title={collapsed ? "Protect Archive UI" : undefined}
      className="flex min-w-0 items-center gap-3 rounded-sm outline-none focus-ring"
    >
      <LogoMark className={compact ? "size-9" : "size-11"} />
      {!collapsed && (
        <span className="flex min-w-0 flex-col leading-tight whitespace-nowrap">
          <span className={cn("truncate font-medium tracking-[-0.01em]", compact ? "text-base" : "text-[1.0625rem]")}>
            Protect Archive UI
          </span>
          {!compact && <span className="truncate text-xs text-muted-foreground">{t("navigation.tagline")}</span>}
        </span>
      )}
    </Link>
  );
}
