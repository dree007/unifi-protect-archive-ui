import type { Metadata } from "next";
import { getI18n } from "@/i18n/server";
import { SystemView } from "@/components/system/system-view";
import { getBackgroundStatus } from "@/server/queries/background-status";
import { getSystemStatus } from "@/server/queries/cameras-system";
import { queryContext } from "@/server/queries/context";

export async function generateMetadata(): Promise<Metadata> { const { t } = await getI18n(); return { title: t("common.system") }; }
export default async function SystemPage() {
  const { locale } = await getI18n();
  const context = queryContext({ locale });
  const [system, background] = await Promise.all([getSystemStatus(context), getBackgroundStatus(context)]);
  return <SystemView system={system} background={background} />;
}
