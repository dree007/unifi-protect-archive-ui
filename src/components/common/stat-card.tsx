import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

import { TONE_CLASSES, type Tone } from "./tone";

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Unit or qualifier next to the value, e.g. "Clips". */
  unit?: string;
  hint?: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  className?: string;
}

export function StatCard({ label, value, unit, hint, icon: Icon, tone = "primary", className }: StatCardProps) {
  return (
    <div className={cn("surface-card flex flex-col gap-3 p-4 sm:p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", TONE_CLASSES[tone])}>
          <Icon aria-hidden className="size-4.5" />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
          {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
        </p>
        {hint && <p className="text-[0.8125rem] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
