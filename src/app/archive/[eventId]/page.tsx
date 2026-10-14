import { getI18n } from "@/i18n/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { EventDetail } from "@/components/events/event-detail";
import { Button } from "@/components/ui/button";
import { archiveReturnHref } from "@/lib/archive-filters";
import { eventTitle } from "@/lib/event-title";
import { getEventDetail } from "@/server/queries/archive";
import { queryContext } from "@/server/queries/context";

export async function generateMetadata(props: PageProps<"/archive/[eventId]">): Promise<Metadata> {
  const { t, locale } = await getI18n();
  const { eventId } = await props.params;
  const event = await getEventDetail(eventId, queryContext({ locale }));
  return { title: event ? eventTitle(event, t) : t("errors.eventNotFound") };
}

export default async function EventPage(props: PageProps<"/archive/[eventId]">) {
  const { t, locale } = await getI18n();
  const { eventId } = await props.params;
  const { from } = await props.searchParams;
  const event = await getEventDetail(eventId, queryContext({ locale }));
  if (!event) notFound();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <Button asChild variant="ghost" className="-ml-3 self-start text-muted-foreground">
        {/* Only known filter params are taken over, always to /archive (no open redirect). */}
        <Link href={archiveReturnHref(typeof from === "string" ? from : undefined)}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          {t("navigation.back")}
        </Link>
      </Button>
      <EventDetail event={event} />
    </div>
  );
}
