"use client";

import { useI18n } from "@/i18n/provider";
import { CardGridSkeleton } from "@/components/archive/archive-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Calm placeholder for the live pages while their data loads. */
export default function Loading() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-4 w-72 rounded-lg" />
      </div>
      <CardGridSkeleton count={4} className="grid-cols-2 lg:grid-cols-4" />
      <CardGridSkeleton count={4} />
    </div>
  );
}
