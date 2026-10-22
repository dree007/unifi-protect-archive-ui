"use client";

import { useI18n } from "@/i18n/provider";
import { Skeleton } from "@/components/ui/skeleton";

/** Calm placeholders in the geometry of the real cards (no spinners). */

export function EventCardSkeleton() {
  return (
    <div className="surface-card flex gap-3.5 p-3 sm:gap-4">
      <Skeleton className="aspect-[4/3] w-24 shrink-0 rounded-sm sm:w-32" />
      <div className="flex flex-1 flex-col gap-2.5 py-1">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-4 w-28 rounded-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function ArchiveSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("archive.loading")} className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full rounded-sm" />
        <div className="flex gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-20 rounded-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32 rounded-full" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <EventCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function EventDetailSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("archive.detailLoading")} className="flex flex-col gap-5">
      <Skeleton className="aspect-video w-full rounded-card" />
      <Skeleton className="h-4 w-32 rounded-full" />
      <Skeleton className="h-7 w-48 rounded-full" />
      <div className="grid grid-cols-2 gap-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-md" />
        ))}
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6, className = "md:grid-cols-2 2xl:grid-cols-3" }: { count?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("common.loading")} className={`grid grid-cols-1 gap-4 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-44 rounded-card" />
      ))}
    </div>
  );
}
