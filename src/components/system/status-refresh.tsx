"use client";

import { useI18n } from "@/i18n/provider";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

/**
 * Re-renders the system page with fresh server data: every `intervalMs` while the tab is
 * visible, and on demand. Only mounted on the system page – no polling elsewhere, no extra
 * WebSocket or SSE connection.
 */
export function StatusRefresh({ intervalMs = 30_000, checkedAtLabel }: { intervalMs?: number; checkedAtLabel: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    };
    const timer = window.setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [intervalMs, router]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {t("system.checkedAt", { time: checkedAtLabel, seconds: Math.round(intervalMs / 1000) })}
      </p>
      <Button variant="outline" onClick={() => startTransition(() => router.refresh())} disabled={pending} aria-busy={pending}>
        <RefreshCw aria-hidden className={cn(pending && "animate-spin motion-reduce:animate-none")} />
        {t("system.refresh")}
      </Button>
    </div>
  );
}
