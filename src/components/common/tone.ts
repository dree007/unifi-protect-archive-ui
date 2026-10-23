/**
 * Status tones from the design tokens (Atelier Soft): sage tint = fine, violet tint = active,
 * ember tint = attention, ember ink = error, stone = neutral, taupe = informational. Always used
 * together with an icon and a label, never as the only carrier of meaning.
 */
export const TONE_CLASSES = {
  success: "bg-success-soft text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  danger: "bg-danger-strong text-on-ink",
  neutral: "bg-neutral-soft text-neutral-strong",
  primary: "bg-selected text-selected-foreground",
  info: "bg-info-soft text-info-strong",
} as const;

export type Tone = keyof typeof TONE_CLASSES;

/**
 * Pastel hues without a status meaning: they give icons, plates and bars a little life (the
 * navigation, dashboard figures, detection types). `soft` is the tint alone, `plate`
 * tint + ink, `solid` for bars and dots.
 */
export const HUE_CLASSES = {
  violet: { soft: "bg-violet-soft", plate: "bg-violet-soft text-violet-ink", ink: "text-violet-ink", solid: "bg-violet-spark" },
  sage: { soft: "bg-sage-soft", plate: "bg-sage-soft text-sage-ink", ink: "text-sage-ink", solid: "bg-sage" },
  sky: { soft: "bg-sky-soft", plate: "bg-sky-soft text-sky-ink", ink: "text-sky-ink", solid: "bg-sky" },
  butter: { soft: "bg-butter-soft", plate: "bg-butter-soft text-butter-ink", ink: "text-butter-ink", solid: "bg-butter" },
  rose: { soft: "bg-rose-soft", plate: "bg-rose-soft text-rose-ink", ink: "text-rose-ink", solid: "bg-rose" },
} as const;

export type Hue = keyof typeof HUE_CLASSES;
