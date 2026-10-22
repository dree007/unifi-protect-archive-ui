"use client";

import { useI18n } from "@/i18n/provider";
import { useState, type ReactNode } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";

import { addCollection, changeCollectionName, loadCollections, removeCollection } from "@/app/archive/actions";
import { CollectionNameForm, CurationSheet, curationErrorMessage } from "@/components/common/curation";
import { Button } from "@/components/ui/button";
import { SheetTrigger } from "@/components/ui/sheet";
import type { CollectionSummary, CurationError } from "@/lib/collections";

const failed = { ok: false, error: "failed" } as const;
const byName = (a: CollectionSummary, b: CollectionSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Sheet to create, rename and delete collections and to show one in the archive. Opened from
 * the filter bar; loads the list with event counts each time it opens.
 */
export function CollectionsManager({
  trigger,
  onShow,
  onChanged,
  onDeleted,
}: {
  /** The button that opens the sheet (wrapped in a SheetTrigger here). */
  trigger: ReactNode;
  /** Filter the archive by this collection (closes the sheet). */
  onShow: (collectionId: string) => void;
  /** Names or the set of collections changed: refresh the filter options. */
  onChanged: () => void;
  onDeleted: (collectionId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionSummary[] | null>();
  const [editing, setEditing] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<CurationError>();

  const load = async () => {
    setCollections(undefined);
    setError(undefined);
    setEditing(undefined);
    setConfirming(undefined);
    const result = await loadCollections().catch(() => failed);
    setCollections(result.ok ? result.value.collections : null);
  };

  const create = async (name: string): Promise<CurationError | undefined> => {
    const result = await addCollection(name).catch(() => failed);
    if (!result.ok) return result.error;
    setCollections((current) => [...(current ?? []), result.value].sort(byName));
    onChanged();
    return undefined;
  };

  const rename = async (collection: CollectionSummary, name: string): Promise<CurationError | undefined> => {
    const result = await changeCollectionName(collection.id, name).catch(() => failed);
    if (!result.ok) return result.error;
    // The server normalized the name the same way; reload to show exactly what is stored.
    setEditing(undefined);
    const fresh = await loadCollections().catch(() => failed);
    if (fresh.ok) setCollections(fresh.value.collections);
    onChanged();
    return undefined;
  };

  const remove = async (collection: CollectionSummary) => {
    setDeleting(true);
    setError(undefined);
    const result = await removeCollection(collection.id).catch(() => failed);
    setDeleting(false);
    setConfirming(undefined);
    if (!result.ok && result.error !== "collection-not-found") {
      setError(result.error);
      return;
    }
    setCollections((current) => current?.filter((c) => c.id !== collection.id));
    onDeleted(collection.id);
    onChanged();
  };

  return (
    <CurationSheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
      title={t("collections.title")}
      description={t("collections.manageDescription")}
      trigger={<SheetTrigger asChild>{trigger}</SheetTrigger>}
    >
      {collections === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t("common.loading")}
        </p>
      ) : collections === null ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm font-medium text-danger-strong">{t("collections.loadFailed")}</p>
          <Button variant="outline" onClick={() => void load()}>{t("common.retry")}</Button>
        </div>
      ) : (
        <>
          <CollectionNameForm submitLabel={t("collections.create")} onSubmit={create} />
          {collections.length === 0 ? (
            <p className="surface-inset px-4 py-3 text-sm text-muted-foreground">{t("collections.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" aria-label={t("collections.title")}>
              {collections.map((collection) => (
                <li key={collection.id} className="flex flex-col gap-2 py-2.5">
                  {editing === collection.id ? (
                    <CollectionNameForm
                      initialName={collection.name}
                      submitLabel={t("collections.save")}
                      onSubmit={(name) => rename(collection, name)}
                      onCancel={() => setEditing(undefined)}
                      autoFocus
                    />
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      <div className="min-w-32 flex-1">
                        <p className="truncate font-medium">{collection.name}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t("collections.eventCount", { count: collection.eventCount })}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("collections.showLabel", { name: collection.name })}
                        onClick={() => {
                          setOpen(false);
                          onShow(collection.id);
                        }}
                      >
                        {t("collections.show")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("collections.rename", { name: collection.name })}
                        onClick={() => {
                          setConfirming(undefined);
                          setEditing(collection.id);
                        }}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("collections.delete", { name: collection.name })}
                        aria-expanded={confirming === collection.id}
                        onClick={() => {
                          setEditing(undefined);
                          setConfirming(confirming === collection.id ? undefined : collection.id);
                        }}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  )}
                  {confirming === collection.id && (
                    <div className="surface-inset flex flex-col gap-2.5 px-4 py-3 text-sm" role="group" aria-label={t("collections.delete", { name: collection.name })}>
                      <p>{t("collections.confirmDelete", { name: collection.name })}</p>
                      <div className="flex gap-2">
                        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void remove(collection)}>
                          {deleting && <Loader2 aria-hidden className="animate-spin" />}
                          {t("collections.confirm")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(undefined)}>
                          {t("collections.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert" className="text-sm font-medium text-danger-strong">{curationErrorMessage(error, t)}</p>}
        </>
      )}
    </CurationSheet>
  );
}
