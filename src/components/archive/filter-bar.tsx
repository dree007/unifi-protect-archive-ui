"use client";

import type { Translator } from "@/i18n/core";
import { useI18n } from "@/i18n/provider";
import { useId } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "cn";

import { SearchInput } from "@/components/archive/search-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  countRefinements,
  PERIODS,
  type ArchiveFilters,
  type CustomRangeIssue,
  type Period,
} from "@/lib/archive-filters";
import { detectionLabel } from "@/lib/labels";
import type { FilterOption } from "@/lib/view-models";

const RANGE_KEYS = { "invalid-from": "errors.invalidFrom", "invalid-to": "errors.invalidTo", "from-after-to": "errors.fromAfterTo" } as const;
const PERIOD_KEYS = { all: "common.all", today: "common.today", "7d": "filters.sevenDays", "30d": "filters.thirtyDays", custom: "common.period" } as const;

function detectionOptions(types: readonly string[], t: Translator): FilterOption[] {
  return [
    { value: "all", label: t("filters.allDetections") },
    ...types.map((type) => ({ value: type, label: detectionLabel(type, t) })),
    { value: "none", label: t("filters.none") },
  ];
}

function cameraOptions(cameras: readonly FilterOption[], t: Translator): FilterOption[] {
  return [{ value: "all", label: t("filters.allCameras") }, ...cameras];
}

/**
 * Single-choice chips (toggle buttons). With `name`, they are submit buttons of the
 * surrounding GET form, so they also work before/without hydration.
 */
function ChipGroup({
  label,
  options,
  value,
  onChange,
  name,
  scrollable = false,
}: {
  label: string;
  options: readonly FilterOption[];
  value: string;
  onChange: (value: string) => void;
  name?: string;
  scrollable?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex gap-2", scrollable ? "scrollbar-none -mx-4 overflow-x-auto px-4 py-1 sm:mx-0 sm:px-0" : "flex-wrap")}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type={name ? "submit" : "button"}
            name={name}
            value={name ? option.value : undefined}
            aria-pressed={active}
            onClick={(event) => {
              event.preventDefault();
              onChange(option.value);
            }}
            className={cn(
              "h-10 shrink-0 rounded-full px-4 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring",
              active
                ? "surface-selected font-semibold"
                : "surface-control text-foreground/80 hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function OnlyDetectedSwitch({ filters, onChange }: { filters: ArchiveFilters; onChange: (patch: Partial<ArchiveFilters>) => void }) {
  const { t } = useI18n();
  const id = useId();
  const disabled = filters.detection === "none";
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Switch
        id={id}
        checked={filters.onlyDetected && !disabled}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ onlyDetected: checked })}
      />
      <Label htmlFor={id} className="text-sm font-medium">
        {t("filters.onlyDetected")}
      </Label>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          "surface-control h-10 rounded-full border-transparent px-4 hover:bg-surface-muted",
          value !== "all" && "surface-selected font-semibold",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Removable chips for the active refinements (calm summary under the bar). */
function ActiveFilters({
  filters,
  cameras,
  onChange,
}: {
  filters: ArchiveFilters;
  cameras: readonly FilterOption[];
  onChange: (patch: Partial<ArchiveFilters>) => void;
}) {
  const { t } = useI18n();
  const chips: { key: string; label: string; clear: Partial<ArchiveFilters> }[] = [];
  if (filters.cameraId !== "all") {
    chips.push({
      key: "camera",
      label: cameras.find((camera) => camera.value === filters.cameraId)?.label ?? t("common.camera"),
      clear: { cameraId: "all" },
    });
  }
  if (filters.detection !== "all") {
    chips.push({
      key: "type",
      label: filters.detection === "none" ? t("filters.none") : detectionLabel(filters.detection, t),
      clear: { detection: "all" },
    });
  }
  if (filters.onlyDetected) chips.push({ key: "detected", label: t("filters.detected"), clear: { onlyDetected: false } });
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t("filters.active")}>
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            onClick={() => onChange(chip.clear)}
            className="surface-selected inline-flex h-9 items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-sm font-medium outline-none hover:brightness-[0.98] focus-visible:ring-3 focus-visible:ring-ring"
            aria-label={t("filters.remove", { label: chip.label })}
          >
            {chip.label}
            <X aria-hidden className="size-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

interface FilterBarProps {
  filters: ArchiveFilters;
  /** Current (possibly not yet applied) search text. */
  search: string;
  onSearchChange: (value: string) => void;
  /** Enter in the search box: apply immediately (no debounce). */
  onSearchSubmit: () => void;
  cameras: readonly FilterOption[];
  detectionTypes: readonly string[];
  rangeIssue?: CustomRangeIssue;
  onChange: (patch: Partial<ArchiveFilters>) => void;
  onReset: () => void;
}

/**
 * Search, period chips and refinements. The bar is a plain GET form on `/archive` (search text,
 * period buttons, date fields, current refinements as hidden fields): hydrated, every change
 * navigates client-side; without JavaScript, Enter and the period chips still filter on the server.
 */
export function FilterBar({
  filters,
  search,
  onSearchChange,
  onSearchSubmit,
  cameras,
  detectionTypes,
  rangeIssue,
  onChange,
  onReset,
}: FilterBarProps) {
  const { t } = useI18n();
  const refinements = countRefinements(filters);
  const fromId = useId();
  const toId = useId();
  const detections = detectionOptions(detectionTypes, t);
  const cameraChoices = cameraOptions(cameras, t);

  const rangeIssueId = useId();

  return (
    <form
      action="/archive"
      method="get"
      role="search"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSearchSubmit();
      }}
    >
      {/* Default button for Enter (implicit submission): keeps the current period instead of
          submitting the first period chip. Invisible; only relevant without JavaScript. */}
      <button type="submit" name="period" value={filters.period} tabIndex={-1} aria-hidden className="sr-only">
        {t("filters.search")}</button>
      {filters.cameraId !== "all" && <input type="hidden" name="camera" value={filters.cameraId} />}
      {filters.detection !== "all" && <input type="hidden" name="type" value={filters.detection} />}
      {filters.onlyDetected && <input type="hidden" name="detected" value="1" />}
      <div className="flex gap-2">
        <SearchInput
          name="q"
          label={t("filters.searchArchive")}
          placeholder={t("filters.placeholder")}
          value={search}
          onChange={onSearchChange}
          className="flex-1"
        />

        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="surface-control relative h-12 rounded-full border-transparent px-4 hover:bg-surface-muted lg:hidden"
            >
              <SlidersHorizontal aria-hidden />
              <span className="sr-only sm:not-sr-only">{t("filters.title")}</span>
              {refinements > 0 && (
                <span className="grid size-5 place-items-center rounded-full bg-selected-foreground text-[0.6875rem] font-semibold text-primary-foreground">
                  {refinements}
                  <span className="sr-only"> {t("filters.activeSuffix")}</span>
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85dvh] gap-5 rounded-t-[1.75rem] border-none bg-card pb-safe shadow-[var(--shadow-elevated)]">
            {/* Grab handle: a calm visual cue that the sheet can be dismissed. */}
            <div aria-hidden className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-border" />
            <SheetHeader className="px-5 pt-0">
              <SheetTitle className="text-lg">{t("filters.title")}</SheetTitle>
              <SheetDescription>{t("filters.description")}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 overflow-y-auto px-5 py-1">
              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-semibold text-muted-foreground">{t("common.camera")}</p>
                <ChipGroup label={t("common.camera")} options={cameraChoices} value={filters.cameraId} onChange={(cameraId) => onChange({ cameraId })} />
              </div>
              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-semibold text-muted-foreground">{t("status.matched")}</p>
                <ChipGroup label={t("status.matched")} options={detections} value={filters.detection} onChange={(detection) => onChange({ detection })} />
              </div>
              <OnlyDetectedSwitch filters={filters} onChange={onChange} />
            </div>
            <SheetFooter className="flex-row gap-2 px-5 pb-5">
              <Button variant="outline" size="lg" className="flex-1" onClick={onReset}>
                {t("common.reset")}
              </Button>
              <SheetClose asChild>
                <Button size="lg" className="flex-1">
                  {t("common.done")}
                </Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <ChipGroup
          label={t("common.period")}
          name="period"
          options={PERIODS.map((period) => ({ value: period, label: t(PERIOD_KEYS[period]) }))}
          value={filters.period}
          onChange={(period) => onChange({ period: period as Period })}
          scrollable
        />
        <div className="hidden items-center gap-2 lg:flex">
          <FilterSelect
            label={t("common.camera")}
            value={filters.cameraId}
            options={cameraChoices}
            onChange={(cameraId) => onChange({ cameraId })}
            className="min-w-40"
          />
          <FilterSelect
            label={t("status.matched")}
            value={filters.detection}
            options={detections}
            onChange={(detection) => onChange({ detection })}
            className="min-w-44"
          />
        </div>
        <div className="hidden lg:block">
          <OnlyDetectedSwitch filters={filters} onChange={onChange} />
        </div>
      </div>

      {filters.period === "custom" && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fromId} className="text-xs text-muted-foreground">
                {t("filters.from")}
              </Label>
              <Input
                id={fromId}
                name="from"
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                aria-invalid={rangeIssue === "invalid-from" || rangeIssue === "from-after-to" || undefined}
                aria-describedby={rangeIssue ? rangeIssueId : undefined}
                onChange={(event) => onChange({ from: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={toId} className="text-xs text-muted-foreground">
                {t("filters.to")}
              </Label>
              <Input
                id={toId}
                name="to"
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                aria-invalid={rangeIssue === "invalid-to" || rangeIssue === "from-after-to" || undefined}
                aria-describedby={rangeIssue ? rangeIssueId : undefined}
                onChange={(event) => onChange({ to: event.target.value })}
              />
            </div>
          </div>
          {rangeIssue && (
            <p id={rangeIssueId} role="status" className="text-sm font-medium text-danger-strong">
              {t(RANGE_KEYS[rangeIssue])}
            </p>
          )}
        </div>
      )}

      <div className="lg:hidden">
        <ActiveFilters filters={filters} cameras={cameras} onChange={onChange} />
      </div>
    </form>
  );
}
