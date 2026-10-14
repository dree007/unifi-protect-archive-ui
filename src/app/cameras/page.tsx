import { getI18n } from "@/i18n/server";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Cctv } from "lucide-react";

import { CameraCard } from "@/components/cameras/camera-card";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { getCameras } from "@/server/queries/cameras-system";
import { queryContext } from "@/server/queries/context";

export async function generateMetadata(): Promise<Metadata> { const { t } = await getI18n(); return { title: t("common.cameras") }; }

export default async function CamerasPage() {
  const { t, locale } = await getI18n();
  await connection();
  const cameras = await getCameras(queryContext({ locale }));
  const online = cameras.filter((camera) => camera.online).length;

  return (
    <>
      <PageHeader
        title={t("common.cameras")}
        description={cameras.length > 0 ? t("cameras.onlineCount", { online, count: cameras.length }) : t("cameras.description")}
      />
      {cameras.length === 0 ? (
        <EmptyState
          icon={Cctv}
          title={t("cameras.empty")}
          description={t("cameras.syncHint")}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {cameras.map((camera) => (
            <li key={camera.id} className="flex">
              <CameraCard camera={camera} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
