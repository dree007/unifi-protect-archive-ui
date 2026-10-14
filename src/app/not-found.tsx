"use client";

import { useI18n } from "@/i18n/provider";
import Link from "next/link";
import { SearchX } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={SearchX}
      title={t("errors.notFound")}
      description={t("errors.notFoundBody")}
      action={
        <Button asChild>
          <Link href="/archive">{t("navigation.toArchive")}</Link>
        </Button>
      }
    />
  );
}
