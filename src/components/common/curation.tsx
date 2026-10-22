"use client";

import type { MessageKey, Translator } from "@/i18n/core";
import { useI18n } from "@/i18n/provider";
import { useId, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { COLLECTION_NAME_MAX_LENGTH, type CurationError } from "@/lib/collections";

/** Shared parts of the favorites/collections UI: error text, the sheet frame and the name form. */

const ERROR_KEYS: Record<CurationError, MessageKey> = {
  "invalid-name": "collections.error.invalid-name",
  "duplicate-name": "collections.error.duplicate-name",
  "event-not-found": "collections.error.event-not-found",
  "collection-not-found": "collections.error.collection-not-found",
  failed: "collections.error.failed",
};

export function curationErrorMessage(error: CurationError, t: Translator): string {
  return t(ERROR_KEYS[error], { max: COLLECTION_NAME_MAX_LENGTH });
}

/** A sheet from the bottom on phones, from the right on larger screens. */
export function CurationSheet({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const wide = useMediaQuery("(min-width: 40rem)");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger}
      <SheetContent
        side={wide ? "right" : "bottom"}
        className={cn(
          "gap-4 border-none bg-card",
          wide ? "w-full sm:max-w-md" : "max-h-[85dvh] rounded-t-card-lg pb-safe",
        )}
      >
        {!wide && <div aria-hidden className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-stone" />}
        <SheetHeader className={cn("px-5 pr-14", wide ? "pt-5" : "pt-0")}>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One-line form for a collection name (create or rename). Resolves the submit itself so the
 * caller only decides what to do with the name; the error comes back from the server.
 */
export function CollectionNameForm({
  initialName = "",
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = false,
}: {
  initialName?: string;
  submitLabel: string;
  /** Returns the error to show, or `undefined` on success (the form then clears itself). */
  onSubmit: (name: string) => Promise<CurationError | undefined>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CurationError>();
  const errorId = useId();

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
        const result = await onSubmit(name);
        setBusy(false);
        setError(result);
        if (!result && !onCancel) setName("");
      }}
    >
      {/* Wraps on narrow phones: the field keeps a usable width, buttons move below. */}
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={t("collections.name")}
          placeholder={t("collections.newPlaceholder")}
          value={name}
          maxLength={COLLECTION_NAME_MAX_LENGTH}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && onCancel) {
              // Close only the inline editor, not the whole sheet.
              event.stopPropagation();
              onCancel();
            }
          }}
          className="min-w-40 flex-1"
        />
        <Button type="submit" disabled={busy || !name.trim()} className="h-11 shrink-0">
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" className="h-11 shrink-0" onClick={onCancel}>
            {t("collections.cancel")}
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger-strong">
          {curationErrorMessage(error, t)}
        </p>
      )}
    </form>
  );
}
