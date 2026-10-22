import { getI18n } from "@/i18n/server";
import Link from "next/link";
import { connection } from "next/server";
import { ArrowRight, CalendarCheck, Cctv, Film, HardDrive } from "lucide-react";

import { Onboarding } from "@/components/common/onboarding";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { DetectionDistribution } from "@/components/dashboard/detection-distribution";
import { LatestDetectionCard } from "@/components/dashboard/latest-detection-card";
import { RecentEvents } from "@/components/dashboard/recent-events";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { formatBytes, formatNumber } from "@/lib/format";
import { queryContext } from "@/server/queries/context";
import { getDashboard } from "@/server/queries/dashboard";

export default async function DashboardPage() {
  const { t, locale } = await getI18n();
  // Live data: render per request, never at build time.
  await connection();
  const dashboard = await getDashboard(queryContext({ locale }));

  return (
    <>
      <PageHeader title={t("common.dashboard")} description={t("dashboard.description")} />

      {dashboard.isEmpty ? (
        <Onboarding />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <LatestDetectionCard detection={dashboard.latestDetection} className="col-span-2 lg:row-span-2" />
            <StatCard label={t("common.today")} value={formatNumber(dashboard.eventsToday, locale)} unit={t("units.events", { count: dashboard.eventsToday })} icon={CalendarCheck} tone="info" />
            <StatCard label={t("common.archive")} value={formatNumber(dashboard.clipsTotal, locale)} unit={t("units.clips", { count: dashboard.clipsTotal })} icon={Film} tone="neutral" />
            <StatCard
              label={t("common.cameras")}
              value={formatNumber(dashboard.camerasOnline, locale)}
              unit={t("dashboard.online", { count: dashboard.camerasTotal })}
              icon={Cctv}
              tone={dashboard.camerasOnline < dashboard.camerasTotal ? "warning" : "success"}
            />
            <StatCard
              label={t("common.storage")}
              value={formatBytes(dashboard.archiveSizeBytes, locale)}
              hint={
                dashboard.lastScanLabel
                  ? t("dashboard.lastScan", { time: dashboard.lastScanLabel, failure: dashboard.lastScanFailed ? t("dashboard.scanFailed") : "" })
                  : t("dashboard.noScan")
              }
              icon={HardDrive}
              tone={dashboard.lastScanFailed ? "warning" : "neutral"}
            />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section aria-labelledby="recent-events" className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 px-1">
                <h2 id="recent-events" className="type-heading">
                  {t("dashboard.recent")}
                </h2>
                <Button asChild variant="ghost" className="text-primary">
                  <Link href="/archive">
                    {t("common.showAll")}<ArrowRight data-icon="inline-end" aria-hidden />
                  </Link>
                </Button>
              </div>
              <RecentEvents events={dashboard.recentEvents} />
            </section>

            <SectionCard title={t("common.detections")} description={t("dashboard.byType")}>
              <DetectionDistribution counts={dashboard.detections} />
            </SectionCard>
          </div>
        </>
      )}
    </>
  );
}
