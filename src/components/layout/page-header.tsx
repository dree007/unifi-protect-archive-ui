import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between lg:mb-8">
      <div className="flex flex-col gap-1">
        <h1 className="type-title">{title}</h1>
        {description && <p className="text-[0.9375rem] text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </header>
  );
}
