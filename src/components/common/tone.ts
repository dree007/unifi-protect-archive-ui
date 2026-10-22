/**
 * Status tones from the design tokens (Atelier Soft): violet tint = fine or active, ember tint =
 * attention, ember ink = error, stone = neutral, taupe = informational. Always used together
 * with an icon and a label, never as the only carrier of meaning.
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
