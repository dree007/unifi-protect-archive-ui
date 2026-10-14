"use client";

import { useI18n } from "@/i18n/provider";
import { ArchiveSkeleton } from "@/components/archive/archive-skeleton";
import { PageHeader } from "@/components/layout/page-header";

export default function ArchiveLoading() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t("common.archive")} description={t("archive.description")} />
      <ArchiveSkeleton />
    </>
  );
}
