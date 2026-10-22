"use client";

import { useI18n } from "@/i18n/provider";
import { useState } from "react";
import { Check, FolderPlus, Loader2, Star } from "lucide-react";
import { cn } from "cn";

import { addCollection, loadCollections, setCollectionMembership, setFavorite } from "@/app/archive/actions";
import { CollectionNameForm, CurationSheet, curationErrorMessage } from "@/components/common/curation";
import { Button } from "@/components/ui/button";
import { SheetTrigger } from "@/components/ui/sheet";
import type { CollectionSummary, CurationError } from "@/lib/collections";
import type { EventDetailModel } from "@/lib/view-models";

/**
 * Favorite and collection membership of one event – a situation, never a single clip
 * (docs/web-ui.md, "Favorites and collections"). Both only write metadata through server
 * functions and keep their state locally: no refresh, no new video request, a running player is
 * never interrupted.
 */

/** The two labeled actions under the event title; hidden while the event has no recording. */
export function EventCuration({ event }: { event: Pick<EventDetailModel, "id" | "favorite" | "collectionIds"> }) {
  const [favorite, setFavorite] = useState(event.favorite);
  const [collectionCount, setCollectionCount] = useState(event.collectionIds.length);
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <FavoriteButton eventId={event.id} favorite={favorite} onChange={setFavorite} onError={setError} />
        <EventCollectionsButton
          eventId={event.id}
          collectionCount={collectionCount}
          onMembershipChange={(ids) => setCollectionCount(ids.length)}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger-strong">
          {error}
        </p>
      )}
    </div>
  );
}

/** Toggle pill: filled star = favorite. Shape and `aria-pressed` carry the state, not color. */
function FavoriteButton({
  eventId,
  favorite,
  onChange,
  onError,
}: {
  eventId: string;
  favorite: boolean;
  onChange: (favorite: boolean) => void;
  onError: (message: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={favorite}
      title={favorite ? t("favorites.unmark") : t("favorites.mark")}
      // Not `disabled` while saving: that would drop the keyboard focus.
      aria-busy={busy || undefined}
      className={cn(favorite && "surface-selected hover:bg-selected hover:text-selected-foreground")}
      onClick={async () => {
        if (busy) return;
        const next = !favorite;
        setBusy(true);
        onError(undefined);
        // Optimistic: the star changes at once and goes back if saving fails.
        onChange(next);
        const result = await setFavorite(eventId, next).catch(() => ({ ok: false, error: "failed" }) as const);
        setBusy(false);
        if (!result.ok) {
          onChange(!next);
          onError(result.error === "failed" ? t("favorites.failed") : curationErrorMessage(result.error, t));
        }
      }}
    >
      <Star data-icon="inline-start" aria-hidden className={cn(favorite && "fill-current")} />
      {t("favorites.label")}
    </Button>
  );
}

type Loaded = { collections: CollectionSummary[]; memberOf: Set<string> };

/** Opens a sheet listing all collections as toggles for this event, plus "create and add". */
function EventCollectionsButton({
  eventId,
  collectionCount,
  onMembershipChange,
}: {
  eventId: string;
  collectionCount: number;
  onMembershipChange: (collectionIds: string[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<CurationError>();

  const load = async () => {
    setLoaded(undefined);
    setError(undefined);
    const result = await loadCollections(eventId).catch(() => ({ ok: false, error: "failed" }) as const);
    if (result.ok) {
      setLoaded({ collections: result.value.collections, memberOf: new Set(result.value.memberOf) });
      onMembershipChange(result.value.memberOf);
    } else {
      setLoaded(null);
      setError(result.error);
    }
  };

  const apply = (next: Loaded) => {
    setLoaded(next);
    onMembershipChange([...next.memberOf]);
  };

  const toggle = async (collection: CollectionSummary) => {
    if (!loaded || pending) return;
    const member = !loaded.memberOf.has(collection.id);
    setPending(collection.id);
    setError(undefined);
    const result = await setCollectionMembership(collection.id, eventId, member).catch(() => ({ ok: false, error: "failed" }) as const);
    setPending(undefined);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const memberOf = new Set(loaded.memberOf);
    if (member) memberOf.add(collection.id);
    else memberOf.delete(collection.id);
    apply({
      memberOf,
      collections: loaded.collections.map((c) => (c.id === collection.id ? { ...c, eventCount: c.eventCount + (member ? 1 : -1) } : c)),
    });
  };

  const createAndAdd = async (name: string): Promise<CurationError | undefined> => {
    const created = await addCollection(name).catch(() => ({ ok: false, error: "failed" }) as const);
    if (!created.ok) return created.error;
    const added = await setCollectionMembership(created.value.id, eventId, true).catch(() => ({ ok: false, error: "failed" }) as const);
    const collection = { ...created.value, eventCount: added.ok ? 1 : 0 };
    const memberOf = new Set(loaded?.memberOf ?? []);
    if (added.ok) memberOf.add(collection.id);
    apply({
      memberOf,
      collections: [...(loaded?.collections ?? []), collection].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    });
    return added.ok ? undefined : added.error;
  };

  return (
    <CurationSheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
      title={t("collections.title")}
      description={t("collections.eventDescription")}
      trigger={
        <SheetTrigger asChild>
          <Button type="button" variant="outline" className={cn(collectionCount > 0 && "surface-selected")}>
            <FolderPlus data-icon="inline-start" aria-hidden />
            {collectionCount > 0 ? t("collections.inCount", { count: collectionCount }) : t("collections.addToCollection")}
          </Button>
        </SheetTrigger>
      }
    >
      {loaded === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t("common.loading")}
        </p>
      ) : loaded === null ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm font-medium text-danger-strong">{t("collections.loadFailed")}</p>
          <Button variant="outline" onClick={() => void load()}>{t("common.retry")}</Button>
        </div>
      ) : (
        <>
          {loaded.collections.length === 0 ? (
            <p className="surface-inset px-4 py-3 text-sm text-muted-foreground">{t("collections.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t("collections.title")}>
              {loaded.collections.map((collection) => {
                const member = loaded.memberOf.has(collection.id);
                return (
                  <li key={collection.id}>
                    <button
                      type="button"
                      aria-pressed={member}
                      aria-busy={pending === collection.id || undefined}
                      onClick={() => void toggle(collection)}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-3 rounded-full px-4 text-left text-sm font-medium outline-none focus-ring",
                        member ? "surface-selected" : "surface-control",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "grid size-5 shrink-0 place-items-center rounded-full border",
                          member ? "border-transparent bg-violet-ink text-on-ink" : "border-input",
                        )}
                      >
                        {pending === collection.id ? <Loader2 className="size-3 animate-spin" /> : member && <Check className="size-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                        {t("collections.eventCount", { count: collection.eventCount })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p role="alert" className="text-sm font-medium text-danger-strong">{curationErrorMessage(error, t)}</p>}
          <CollectionNameForm submitLabel={t("collections.createAndAdd")} onSubmit={createAndAdd} />
        </>
      )}
    </CurationSheet>
  );
}
