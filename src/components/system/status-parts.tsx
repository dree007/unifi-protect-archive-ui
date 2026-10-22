import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

import { TONE_CLASSES, type Tone } from "@/components/common/tone";

/** Building blocks of the system page: soft status pill, fact list, metric tile, notice. */

export interface StatusBadge {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** Spinning icon for states in progress (still with reduced motion respected). */
  spin?: boolean;
}

export function StatusPill({ badge }: { badge: StatusBadge }) {
  const Icon = badge.icon;
  return (
    <span
      className={cn(
        "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full py-1 pr-3 pl-2.5 text-[0.8125rem] leading-tight font-medium",
        TONE_CLASSES[badge.tone],
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", badge.spin && "animate-spin [animation-duration:2.5s] motion-reduce:animate-none")} />
      {badge.label}
    </span>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-border text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right font-medium tabular-nums break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Metric({ label, value, tone, dot }: { label: string; value: string; tone?: "warning"; dot?: string }) {
  return (
    <div className="surface-inset flex min-w-0 flex-col gap-1 px-4 py-3">
      <dt className="flex min-w-0 items-center gap-2 text-sm break-words text-muted-foreground">
        {/* Legend for a bar (the label carries the meaning). */}
        {dot && <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", dot)} />}
        {label}
      </dt>
      <dd className={cn("text-xl font-medium tabular-nums", tone === "warning" && "text-warning-strong")}>{value}</dd>
    </div>
  );
}

/**
 * Soft, tinted note under a status (error text, hint). Never a loud alarm surface: errors use
 * the ember tint here – the status pill above already carries the solid error tone.
 */
const NOTICE_CLASSES = { ...TONE_CLASSES, danger: "bg-danger-soft text-danger-strong" };

export function Notice({ tone, children }: { tone: Extract<Tone, "danger" | "warning" | "neutral" | "info">; children: ReactNode }) {
  return (
    <p className={cn("rounded-md px-4 py-3 text-sm [overflow-wrap:anywhere]", NOTICE_CLASSES[tone])} role="status">
      {children}
    </p>
  );
}
