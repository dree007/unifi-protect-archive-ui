"use client";
import { useI18n } from "@/i18n/provider";
import { Car, Film, type LucideIcon, Package, PawPrint, RectangleEllipsis, ScanFace, Tag, User } from "lucide-react";
import { cn } from "cn";

import { detectionLabel } from "@/lib/labels";

interface DetectionStyle {
  icon: LucideIcon;
  /** Soft background + readable foreground. */
  badge: string;
  /** Solid color for bars and dots. */
  solid: string;
}

/**
 * The one place that assigns colors to detection types: soft pastel surfaces with dark ink
 * (≥ 6:1, see globals.css) – person lavender, vehicle blue, animal mint, package blush.
 * Always icon + text, never color alone.
 */
const KNOWN_STYLES: Record<string, DetectionStyle> = {
  person: { icon: User, badge: "bg-detect-person text-detect-person-ink", solid: "bg-detect-person-solid" },
  vehicle: { icon: Car, badge: "bg-detect-vehicle text-detect-vehicle-ink", solid: "bg-detect-vehicle-solid" },
  animal: { icon: PawPrint, badge: "bg-detect-animal text-detect-animal-ink", solid: "bg-detect-animal-solid" },
  package: { icon: Package, badge: "bg-detect-package text-detect-package-ink", solid: "bg-detect-package-solid" },
  face: { icon: ScanFace, badge: "bg-detect-face text-detect-face-ink", solid: "bg-detect-face-solid" },
  licensePlate: { icon: RectangleEllipsis, badge: "bg-detect-plate text-detect-plate-ink", solid: "bg-detect-plate-solid" },
};

/** Unknown/new Protect types: a neutral generic style. */
const GENERIC_STYLE: DetectionStyle = { icon: Tag, badge: "bg-detect-other text-detect-other-ink", solid: "bg-detect-other-solid" };
const ARCHIVE_CLIP_STYLE = { icon: Film, badge: "bg-pastel-neutral text-pastel-neutral-ink" };

export function detectionStyle(type: string): DetectionStyle {
  return Object.hasOwn(KNOWN_STYLES, type) ? KNOWN_STYLES[type] : GENERIC_STYLE;
}

interface DetectionBadgeProps {
  /** Any Protect detection type; `null` renders the neutral "Archivclip" badge. */
  type: string | null;
  size?: "sm" | "md";
  className?: string;
}

export function DetectionBadge({ type, size = "md", className }: DetectionBadgeProps) {
  const { t } = useI18n();
  const style = type === null ? ARCHIVE_CLIP_STYLE : detectionStyle(type);
  const label = type === null ? t("events.archiveClip") : detectionLabel(type, t);
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 pr-2.5 pl-2 text-xs" : "h-7 pr-3 pl-2.5 text-[0.8125rem]",
        style.badge,
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3.5" : "size-4"} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** All detection badges, or – without detections – nothing (status badges explain the rest). */
export function DetectionBadgeList({
  types,
  size,
  className,
}: {
  types: readonly string[];
  size?: "sm" | "md";
  className?: string;
}) {
  if (types.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {types.map((type) => (
        <DetectionBadge key={type} type={type} size={size} />
      ))}
    </div>
  );
}
