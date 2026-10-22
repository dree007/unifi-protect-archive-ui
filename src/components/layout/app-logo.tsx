"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { Cctv } from "lucide-react";
import { cn } from "cn";

export function AppLogo({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      href="/"
      className="flex min-w-0 items-center gap-3 rounded-sm outline-none focus-ring"
    >
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center rounded-sm bg-ink text-on-ink",
          compact ? "size-9" : "size-11",
        )}
      >
        <Cctv className={compact ? "size-5" : "size-6"} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn("font-medium tracking-[-0.01em]", compact ? "text-base" : "text-[1.0625rem]")}>
          Protect Archive UI
        </span>
        {!compact && <span className="text-xs text-muted-foreground">{t("navigation.tagline")}</span>}
      </span>
    </Link>
  );
}
