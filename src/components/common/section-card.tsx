import { useId, type ReactNode } from "react";
import { cn } from "cn";

interface SectionCardProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Titled content card for dashboard and system sections. */
export function SectionCard({ title, description, action, children, className }: SectionCardProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("surface-card flex flex-col gap-5 p-5 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="type-heading">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
