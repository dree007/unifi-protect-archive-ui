"use client";

import { useI18n } from "@/i18n/provider";
import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { VideoOff } from "lucide-react";
import { cn } from "cn";

import { ClipThumbnail } from "@/components/events/clip-thumbnail";
import { VideoPreview } from "@/components/events/video-preview";
import { formatDuration } from "@/lib/format";
import type { ClipModel } from "@/lib/view-models";

interface ClipPlayerProps {
  clips: ClipModel[];
  /** Shown on the placeholder when there are no clips. */
  cameraName: string;
  pending: boolean;
  /**
   * Embed player and clip selection in a soft card of their own (detail page). Off inside an
   * existing card (desktop side panel) – no card in a card.
   */
  framed?: boolean;
}

/**
 * Native player for one clip of an event, with a tab list to switch between the clips
 * (several cameras, or several clips of one camera). Only the selected clip has a `<video>`
 * element; switching remounts it, which stops the previous one. No autoplay, metadata only
 * until the user presses play; the thumbnail is the poster.
 */
export function ClipPlayer({ clips, cameraName, pending, framed = false }: ClipPlayerProps) {
  const { t, locale } = useI18n();
  const [selectedId, setSelectedId] = useState(clips[0]?.id);
  const selected = clips.find((clip) => clip.id === selectedId) ?? clips[0];
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!selected) {
    return <VideoPreview variant="player" cameraName={cameraName} pending={pending} />;
  }

  const panelId = `${baseId}-panel`;
  const select = (index: number) => {
    const clip = clips[(index + clips.length) % clips.length];
    setSelectedId(clip.id);
    tabs.current[clips.indexOf(clip)]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: clips.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div className={cn("flex flex-col gap-3", framed && "surface-card p-2 sm:p-2.5")}>
      <div
        id={panelId}
        role={clips.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={clips.length > 1 ? `${baseId}-tab-${selected.id}` : undefined}
        // Inside the frame the radius shrinks by the padding, so the curves stay concentric.
        className={cn(
          "overflow-hidden bg-media",
          framed ? "rounded-[calc(var(--radius-card)-0.5rem)] sm:rounded-[calc(var(--radius-card)-0.625rem)]" : "rounded-[var(--radius-inner)]",
        )}
      >
        <ClipVideo key={selected.id} clip={selected} />
      </div>

      {clips.length > 1 && (
        <div
          role="tablist"
          aria-label={t("events.selectRecording")}
          // Wraps instead of scrolling: every clip stays visible, also in the narrow side panel.
          className={cn("flex flex-wrap gap-2", framed && "px-1 pb-1")}
        >
          {clips.map((clip, index) => {
            const isSelected = clip.id === selected.id;
            return (
              <button
                key={clip.id}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                id={`${baseId}-tab-${clip.id}`}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={panelId}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setSelectedId(clip.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  "flex min-h-11 max-w-full items-center gap-2.5 rounded-[var(--radius-control)] py-1.5 pr-3.5 pl-1.5 text-left text-sm outline-none transition-colors duration-200 focus-visible:ring-3 focus-visible:ring-ring",
                  isSelected ? "surface-selected" : "surface-control text-foreground hover:bg-surface-muted",
                )}
              >
                <span className="relative block aspect-[4/3] w-12 shrink-0 overflow-hidden rounded-[calc(var(--radius-control)-0.375rem)] bg-pastel-neutral">
                  <ClipThumbnail key={clip.thumbnailUrl} src={clip.thumbnailUrl} />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate font-medium">{clip.label}</span>
                  <span className={cn("text-xs tabular-nums", isSelected ? "opacity-85" : "text-muted-foreground")}>
                    {formatDuration(clip.durationSeconds, locale)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FAILURE_TEXT = {
  unavailable: {
    title: "errors.videoUnavailable",
    text: "errors.videoUnavailableBody",
  },
  unsupported: {
    title: "errors.videoUnsupported",
    text: "errors.videoUnsupportedBody",
  },
} as const;

function ClipVideo({ clip }: { clip: ClipModel }) {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "ready" | keyof typeof FAILURE_TEXT>("loading");

  // A media error does not say why. If the endpoint still answers HEAD with 200, the file is
  // there and the browser cannot decode it; otherwise the file (or archive) is unavailable.
  const onFailure = useCallback(() => {
    fetch(clip.videoUrl, { method: "HEAD" })
      .then((response) => setState(response.ok ? "unsupported" : "unavailable"))
      .catch(() => setState("unavailable"));
  }, [clip.videoUrl]);

  // The server-rendered element may have loaded metadata or failed before hydration.
  const checkState = useCallback(
    (video: HTMLVideoElement | null) => {
      if (video?.error) onFailure();
      else if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) setState("ready");
    },
    [onFailure],
  );

  if (state === "unavailable" || state === "unsupported") {
    const { title, text } = FAILURE_TEXT[state];
    return (
      <div role="status" className="flex aspect-video flex-col items-center justify-center gap-2 px-6 text-center text-primary-foreground">
        <VideoOff aria-hidden className="size-8 opacity-70" />
        <p className="font-medium">{t(title)}</p>
        <p className="max-w-sm text-sm opacity-75">
          {clip.label}: {t(text)}
        </p>
      </div>
    );
  }

  return (
    <video
      ref={checkState}
      src={clip.videoUrl}
      poster={clip.thumbnailUrl}
      controls
      preload="metadata"
      playsInline
      aria-label={t("events.videoLabel", { label: clip.label, start: clip.startLabel, end: clip.endLabel })}
      onLoadedMetadata={() => setState("ready")}
      onError={onFailure}
      // Until the real size is known, reserve a 16:9 area; afterwards the clip keeps its own
      // aspect ratio (e.g. 4:3 doorbells), limited in height.
      className={cn("block max-h-[70vh] w-full bg-media object-contain", state === "loading" && "aspect-video")}
    />
  );
}
