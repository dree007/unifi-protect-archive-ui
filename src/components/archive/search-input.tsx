"use client";

import { useI18n } from "@/i18n/provider";
import { Search, X } from "lucide-react";
import { cn } from "cn";

import { Input } from "@/components/ui/input";

interface SearchInputProps {
  /** Form field name (the archive filter form submits it as `q`). */
  name?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}

export function SearchInput({ name, value, onChange, placeholder, label, className }: SearchInputProps) {
  const { t } = useI18n();
  return (
    <div className={cn("relative", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        name={name}
        enterKeyHint="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 pr-12 pl-12 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("filters.clearSearch")}
          className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground outline-none transition-colors duration-120 hover:bg-muted hover:text-foreground focus-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
