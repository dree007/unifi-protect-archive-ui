import type { MetadataStatus } from "@/domain/types";

/**
 * Overview rule for events without a recording (`pendingClip`): they are listed for a short
 * grace period, then left out of event lists and counters until a clip is linked (which makes
 * them `matched` and visible again). Nothing is deleted or rewritten; detail links keep working.
 *
 * The reference is the end of the event – a clip cannot be complete before that – or its start
 * while no end is known (ongoing, or Protect never reported the end).
 */
export const PENDING_CLIP_GRACE_MS = 3 * 60_000;

export interface PendingClipTiming {
  status: MetadataStatus;
  startAt: Date;
  endAt: Date | null;
}

/** When the event leaves the overview (ms since epoch, hidden from then on), or `null` if it never does. */
export function pendingClipHiddenAt({ status, startAt, endAt }: PendingClipTiming): number | null {
  if (status !== "pendingClip") return null;
  return (endAt ?? startAt).getTime() + PENDING_CLIP_GRACE_MS;
}

/**
 * Time until a rendered card leaves the overview, measured against the server clock it was
 * rendered with (so a skewed browser clock does not matter); `null` if it never does.
 */
export function cardHiddenInMs(card: { status: MetadataStatus; presentation?: { start: string; end: string | null; now: string } }): number | null {
  if (!card.presentation) return null;
  const { start, end, now } = card.presentation;
  const hiddenAt = pendingClipHiddenAt({ status: card.status, startAt: new Date(start), endAt: end === null ? null : new Date(end) });
  return hiddenAt === null ? null : hiddenAt - new Date(now).getTime();
}
