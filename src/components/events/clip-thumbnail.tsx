"use client";

import { useCallback, useState } from "react";
import { cn } from "cn";

interface ClipThumbnailProps {
  src: string;
  className?: string;
}

/**
 * Lazily loaded preview JPEG, laid over a placeholder (the parent's background). Removed if it
 * fails (404/422/503), so the soft placeholder underneath shows instead – never a broken-image
 * icon. Decorative: the surrounding element carries the accessible name. Remount
 * (`key={src}`) when the source changes.
 *
 * Visible from the server-rendered HTML on, without waiting for hydration: an earlier version
 * kept the image at opacity 0 until React saw `load`, so every thumbnail stayed invisible
 * whenever the page was not hydrated (e.g. `next dev` opened via a LAN IP that is not in
 * ALLOWED_DEV_ORIGINS). A broken image with `alt=""` renders nothing in the meantime.
 */
export function ClipThumbnail({ src, className }: ClipThumbnailProps) {
  const [failed, setFailed] = useState(false);

  // An image can fail before hydration, when React's onError handler is not attached yet.
  const checkBroken = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- served by our own endpoint, already sized and cached
    <img
      ref={checkBroken}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      data-thumbnail=""
      onError={() => setFailed(true)}
      className={cn("absolute inset-0 size-full object-cover", className)}
    />
  );
}
