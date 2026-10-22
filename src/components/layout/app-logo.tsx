"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { LogoMark } from "@/components/layout/logo-mark";
import { cn } from "cn";

export function AppLogo({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      href="/"
      className="flex min-w-0 items-center gap-3 rounded-sm outline-none focus-ring"
    >
      <LogoMark className={compact ? "size-9" : "size-11"} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn("font-medium tracking-[-0.01em]", compact ? "text-base" : "text-[1.0625rem]")}>
          Protect Archive UI
        </span>
        {!compact && <span className="text-xs text-muted-foreground">{t("navigation.tagline")}</span>}
      </span>
    </Link>
  );
}
