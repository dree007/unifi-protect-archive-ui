"use client";

import { useEffect, useRef, useState } from "react";

import { cardHiddenInMs } from "@/lib/pending-clip";
import type { EventCardModel } from "@/lib/view-models";

/**
 * Applies the overview rule of src/lib/pending-clip.ts while a list stays open: pending cards
 * disappear when their grace period is over. One timer for the next due card, no requests.
 * Each card's deadline is fixed when it is first seen, from the server clock it was rendered
 * with. A card that arrives with a clip (status no longer pending) is always shown.
 */
export function useShownEvents<T extends EventCardModel>(events: readonly T[]): readonly T[] {
  const deadlines = useRef(new Map<string, number>());
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const seenAt = Date.now();
    const due: { id: string; at: number }[] = [];
    for (const event of events) {
      const hiddenIn = cardHiddenInMs(event);
      if (hiddenIn === null) continue;
      let at = deadlines.current.get(event.id);
      if (at === undefined) {
        at = seenAt + hiddenIn;
        deadlines.current.set(event.id, at);
      }
      due.push({ id: event.id, at });
    }
    if (due.length === 0) return;

    const check = () => {
      const now = Date.now();
      const over = due.filter(({ at }) => at <= now).map(({ id }) => id);
      if (over.length > 0) {
        setExpired((current) => (over.every((id) => current.has(id)) ? current : new Set([...current, ...over])));
      }
      const upcoming = due.filter(({ at }) => at > now).map(({ at }) => at);
      if (upcoming.length > 0) timer = setTimeout(check, Math.min(...upcoming) - now);
    };
    let timer = setTimeout(check, 0);
    return () => clearTimeout(timer);
  }, [events]);

  if (expired.size === 0) return events;
  return events.filter((event) => !(expired.has(event.id) && event.status === "pendingClip"));
}
