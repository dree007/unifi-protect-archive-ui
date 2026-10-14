/** Status tones from the design tokens: soft background + strong, readable text. */
export const TONE_CLASSES = {
  success: "bg-success-soft text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  danger: "bg-danger-soft text-danger-strong",
  neutral: "bg-neutral-soft text-neutral-strong",
  primary: "bg-pastel-lavender text-pastel-lavender-ink",
  info: "bg-pastel-blue text-pastel-blue-ink",
} as const;

export type Tone = keyof typeof TONE_CLASSES;
