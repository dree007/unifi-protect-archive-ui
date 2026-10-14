import { EventDetailSkeleton } from "@/components/archive/archive-skeleton";

export default function EventLoading() {
  return (
    <div className="mx-auto max-w-4xl pt-14">
      <EventDetailSkeleton />
    </div>
  );
}
