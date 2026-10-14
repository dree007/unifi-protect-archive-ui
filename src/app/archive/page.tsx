import { getI18n } from "@/i18n/server";
import type { Metadata } from "next";

import { ArchiveBrowser } from "@/components/archive/archive-browser";
import { Onboarding } from "@/components/common/onboarding";
import { PageHeader } from "@/components/layout/page-header";
import { customRangeIssue, parseArchiveFilters } from "@/lib/archive-filters";
import { getArchivePage, getCameraFilterOptions, getDetectionTypeOptions, hasArchiveEvents } from "@/server/queries/archive";
import { queryContext } from "@/server/queries/context";

export async function generateMetadata(): Promise<Metadata> { const { t } = await getI18n(); return { title: t("common.archive") }; }

export default async function ArchivePage(props: PageProps<"/archive">) {
  const { t, locale } = await getI18n();
  // Reading searchParams makes this page render per request (never at build time).
  const searchParams = await props.searchParams;
  const filters = parseArchiveFilters(searchParams);
  const rangeIssue = customRangeIssue(searchParams, filters);
  const context = queryContext({ locale });

  if (!(await hasArchiveEvents(context))) {
    return (
      <>
        <PageHeader title={t("common.archive")} description={t("archive.description")} />
        <Onboarding />
      </>
    );
  }

  const [firstPage, cameras, detectionTypes] = [
    // Start after end matches nothing: no query, the UI explains the range instead.
    rangeIssue === "from-after-to" ? { events: [], nextCursor: null } : await getArchivePage(filters, null, context),
    await getCameraFilterOptions(context),
    await getDetectionTypeOptions(context),
  ];

  return (
    <>
      <PageHeader title={t("common.archive")} description={t("archive.description")} />
      <ArchiveBrowser filters={filters} firstPage={firstPage} cameras={cameras} detectionTypes={detectionTypes} rangeIssue={rangeIssue} />
    </>
  );
}
