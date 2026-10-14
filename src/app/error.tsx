"use client";

import { useI18n } from "@/i18n/provider";
import { useEffect } from "react";
import { CloudOff } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for all pages. A failed query is shown as an error – never as an empty archive.
 * Server errors reach the browser only as a generic message with a digest (no SQL details).
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col gap-3">
      <EmptyState
        icon={CloudOff}
        title={t("errors.databaseTitle")}
        description={t("errors.databaseBody")}
        action={<Button onClick={() => retry()}>{t("common.retry")}</Button>}
      />
      {error.digest && <p className="text-center text-xs text-muted-foreground">{t("errors.id")}{error.digest}</p>}
    </div>
  );
}
