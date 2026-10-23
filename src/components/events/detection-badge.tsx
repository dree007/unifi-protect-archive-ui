"use client";
import { useI18n } from "@/i18n/provider";
import { Car, Film, type LucideIcon, Package, PawPrint, RectangleEllipsis, ScanFace, Tag, User } from "lucide-react";
import { cn } from "cn";

import { HUE_CLASSES, type Hue } from "@/components/common/tone";
import { detectionLabel } from "@/lib/labels";

interface DetectionStyle {
  icon: LucideIcon;
  /** Soft background + readable foreground. */
  badge: string;
  /** Solid color for bars and dots. */
  solid: string;
  /** Tint alone and ink alone, for larger surfaces such as the latest-detection card. */
  surface?: string;
  ink?: string;
}

/**
 * The one place that styles detection types. Each known type has its own pastel hue (ink on
 * tint, ≥ 5.4:1); the icon and label still tell them apart – color is never the only carrier.
 */
const hue = (name: Hue) => ({ badge: HUE_CLASSES[name].plate, solid: HUE_CLASSES[name].solid, surface: HUE_CLASSES[name].soft, ink: HUE_CLASSES[name].ink });
const KNOWN_STYLES: Record<string, DetectionStyle> = {
  person: { icon: User, ...hue("violet") },
  vehicle: { icon: Car, ...hue("sky") },
  animal: { icon: PawPrint, ...hue("sage") },
  package: { icon: Package, ...hue("butter") },
  face: { icon: ScanFace, ...hue("rose") },
  licensePlate: { icon: RectangleEllipsis, ...hue("sky") },
};

/** Unknown/new Protect types: a neutral generic style. */
const GENERIC_STYLE: DetectionStyle = { icon: Tag, badge: "bg-neutral-soft text-neutral-strong", solid: "bg-ash" };
const ARCHIVE_CLIP_STYLE = { icon: Film, badge: "bg-neutral-soft text-neutral-strong" };

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
