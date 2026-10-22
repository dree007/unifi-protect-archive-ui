import { cn } from "cn";

// Same shapes as src/app/icon.svg; keep both in sync. The back layers are violet-spark mixed
// toward eggshell so they stay opaque where they overlap.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="11.25 10.65 42 42" aria-hidden className={cn("shrink-0", className)}>
      <g transform="matrix(1 0.268 0 1 0 0)">
        <rect
          x="31.9"
          y="4"
          width="18.6"
          height="21.4"
          rx="2"
          className="fill-[color-mix(in_srgb,var(--violet-spark)_16%,var(--eggshell))]"
        />
        <rect
          x="25.9"
          y="8.6"
          width="21.3"
          height="21.4"
          rx="2"
          className="fill-[color-mix(in_srgb,var(--violet-spark)_32%,var(--eggshell))]"
        />
        <rect
          x="19.9"
          y="13.3"
          width="24.2"
          height="21.4"
          rx="2"
          className="fill-[color-mix(in_srgb,var(--violet-spark)_55%,var(--eggshell))]"
        />
        <path
          className="fill-violet-spark"
          d="M14 38V20.5Q14 18.5 16 18.5H21.4Q22.4 18.5 23.1 19.3L23.7 19.9Q24 20.2 24.5 20.2H38.3Q40.3 20.2 40.3 22.2V38Q40.3 40 38.3 40H16Q14 40 14 38Z"
        />
      </g>
      <path
        d="M23 33.4L28.9 37.1L23 40.6Z"
        strokeWidth="1.4"
        strokeLinejoin="round"
        className="fill-eggshell stroke-eggshell"
      />
    </svg>
  );
}
