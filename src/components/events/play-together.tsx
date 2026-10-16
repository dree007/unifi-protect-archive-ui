"use client";

import { useI18n } from "@/i18n/provider";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pause, Play, Volume2, VolumeX, VideoOff } from "lucide-react";
import { cn } from "cn";

import { FAILURE_TEXT, releaseVideo, restoreSource, videoFailure } from "@/components/events/video-element";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { createDateFormat } from "@/lib/date-format";
import { initialPair, SyncController, type ClipPhase, type SlotIndex, type SyncSnapshot, type TimedClip } from "@/lib/sync-playback";
import type { ClipModel } from "@/lib/view-models";

/** UI refresh and sync interval while playing (no updates while paused). */
const TICK_MS = 250;
const SLOTS = [0, 1] as const;

interface PlayTogetherProps {
  clips: ClipModel[];
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Gemeinsam abspielen": two clips of an event side by side (stacked on phones), synchronized
 * by recording time with one shared timeline (src/lib/sync-playback.ts). Exactly two video
 * elements, created only while the sheet is open and released when it closes or a clip is
 * replaced. Both start muted; at most one is audible.
 */
export function PlayTogether({ clips, timeZone, open, onOpenChange }: PlayTogetherProps) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="top-0 gap-0 overflow-y-auto border-none bg-card pb-safe shadow-[var(--shadow-elevated)] sm:inset-x-4 sm:top-8 sm:data-[side=bottom]:bottom-auto sm:mx-auto sm:max-h-[calc(100dvh-4rem)] sm:max-w-6xl sm:rounded-[1.75rem]"
      >
        <SheetHeader className="px-4 pt-4 pr-14 pb-3 sm:px-6 sm:pt-5">
          <SheetTitle className="text-lg">{t("together.open")}</SheetTitle>
          <SheetDescription>{t("together.description")}</SheetDescription>
        </SheetHeader>
        {/* Mounted only while open: no video data before, everything released after. */}
        {open && <TogetherView clips={clips} timeZone={timeZone} />}
      </SheetContent>
    </Sheet>
  );
}

const timed = (clip: ClipModel): TimedClip => ({ id: clip.id, startMs: Date.parse(clip.start), endMs: Date.parse(clip.end) });

/** "1:05" (minutes:seconds into the shared timeline). */
function offsetLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function TogetherView({ clips, timeZone }: { clips: ClipModel[]; timeZone: string }) {
  const { t, locale } = useI18n();
  const format = createDateFormat(timeZone, locale);
  const [pair, setPair] = useState(() => initialPair(clips));
  const [audio, setAudio] = useState<SlotIndex | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [controller] = useState(
    () =>
      new SyncController([timed(pair[0]), timed(pair[1])], () => performance.now(), () => {
        setAudio(null);
        setAudioBlocked(true);
      }),
  );
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(() => controller.tick());
  const refresh = useCallback(() => setSnapshot(controller.tick()), [controller]);

  // One timer while playing; none while paused.
  useEffect(() => {
    if (!snapshot.playing) return;
    const timer = setInterval(refresh, TICK_MS);
    return () => clearInterval(timer);
  }, [snapshot.playing, refresh]);

  const toggle = () => {
    if (controller.isPlaying()) controller.pause();
    else controller.play();
    refresh();
  };
  const replace = (index: SlotIndex, clipId: string) => {
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    controller.setClip(index, timed(clip));
    setPair((current) => (index === 0 ? [clip, current[1]] : [current[0], clip]));
    refresh();
  };
  const toggleAudio = (index: SlotIndex) => {
    const next = audio === index ? null : index;
    controller.setAudio(next);
    setAudio(next);
    setAudioBlocked(false);
  };

  const { timeline, positionMs, playing } = snapshot;
  const span = timeline.endMs - timeline.startMs;
  const at = format.timeWithSeconds(new Date(positionMs));

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {SLOTS.map((index) => (
          <TogetherSlot
            key={index}
            index={index}
            clip={pair[index]}
            phase={snapshot.phases[index]}
            choices={clips.length > 2 ? clips.filter((clip) => clip.id !== pair[index === 0 ? 1 : 0].id) : undefined}
            onReplace={(clipId) => replace(index, clipId)}
            audible={audio === index}
            onToggleAudio={() => toggleAudio(index)}
            controller={controller}
            refresh={refresh}
            formatTime={(ms) => format.timeWithSeconds(new Date(ms))}
          />
        ))}
      </div>

      <div className="surface-inset flex items-center gap-3 px-3 py-2.5 sm:gap-4 sm:px-4">
        <Button size="icon-lg" className="shrink-0 rounded-full" onClick={toggle} aria-label={playing ? t("together.pause") : t("together.play")}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            type="range"
            min={0}
            max={span}
            step={100}
            value={positionMs - timeline.startMs}
            onChange={(event) => {
              controller.seek(timeline.startMs + Number(event.target.value));
              refresh();
            }}
            aria-label={t("together.position")}
            aria-valuetext={at}
            className="h-6 w-full cursor-pointer accent-primary"
          />
          <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground" data-together-time>
              {at}
            </span>
            <span>
              {offsetLabel(positionMs - timeline.startMs)} / {offsetLabel(span)}
            </span>
          </div>
        </div>
      </div>
      {audioBlocked && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("together.audioBlocked")}
        </p>
      )}
    </div>
  );
}

interface TogetherSlotProps {
  index: SlotIndex;
  clip: ClipModel;
  phase: ClipPhase;
  choices: ClipModel[] | undefined;
  onReplace: (clipId: string) => void;
  audible: boolean;
  onToggleAudio: () => void;
  controller: SyncController;
  refresh: () => void;
  formatTime: (ms: number) => string;
}

function TogetherSlot({ index, clip, phase, choices, onReplace, audible, onToggleAudio, controller, refresh, formatTime }: TogetherSlotProps) {
  const { t } = useI18n();
  const Speaker = audible ? Volume2 : VolumeX;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={clip.label}>
      <div className="flex min-h-10 items-center justify-between gap-2">
        {choices ? (
          <Select value={clip.id} onValueChange={onReplace}>
            <SelectTrigger
              aria-label={t("together.choose", { slot: index + 1 })}
              className="surface-control h-10 min-w-0 rounded-full border-transparent px-4 font-medium hover:bg-surface-muted"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {choices.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="truncate px-1 font-medium">{clip.label}</p>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full"
          aria-pressed={audible}
          aria-label={t(audible ? "together.audioOff" : "together.audioOn", { label: clip.label })}
          onClick={onToggleAudio}
        >
          <Speaker aria-hidden />
        </Button>
      </div>
      {/* New clip → new element: the old one is released on unmount. */}
      <SlotVideo key={clip.id} index={index} clip={clip} phase={phase} controller={controller} refresh={refresh} formatTime={formatTime} />
    </section>
  );
}

function SlotVideo({
  index,
  clip,
  phase,
  controller,
  refresh,
  formatTime,
}: Pick<TogetherSlotProps, "index" | "clip" | "phase" | "controller" | "refresh" | "formatTime">) {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "ready" | keyof typeof FAILURE_TEXT>("loading");

  const attach = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      restoreSource(video, clip.videoUrl);
      controller.attach(index, video);
      return () => {
        controller.attach(index, null);
        releaseVideo(video);
      };
    },
    [controller, index, clip.videoUrl],
  );
  const fail = () => {
    controller.setFailed(index);
    refresh();
    void videoFailure(clip.videoUrl).then(setState);
  };

  if (state === "unavailable" || state === "unsupported") {
    const { title, text } = FAILURE_TEXT[state];
    return (
      <div role="status" className="flex aspect-video flex-col items-center justify-center gap-2 rounded-[var(--radius-inner)] bg-media px-6 text-center text-primary-foreground">
        <VideoOff aria-hidden className="size-7 opacity-70" />
        <p className="font-medium">{t(title)}</p>
        <p className="max-w-sm text-sm opacity-75">{t(text)}</p>
      </div>
    );
  }

  const idle = phase.phase !== "active";
  return (
    <div className="relative aspect-video overflow-hidden rounded-[var(--radius-inner)] bg-media">
      <video
        ref={attach}
        src={clip.videoUrl}
        poster={clip.thumbnailUrl}
        preload="metadata"
        playsInline
        muted
        data-together-video={clip.id}
        aria-label={t("events.videoLabel", { label: clip.label, start: clip.startLabel, end: clip.endLabel })}
        onLoadedMetadata={() => {
          setState("ready");
          refresh();
        }}
        onWaiting={() => controller.setWaiting(index, true)}
        onPlaying={() => controller.setWaiting(index, false)}
        onCanPlay={() => {
          controller.setWaiting(index, false);
          refresh();
        }}
        onError={fail}
        className={cn("size-full object-contain transition-opacity duration-300", idle && "opacity-40")}
      />
      {state === "loading" && (
        <span className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-media/70 text-primary-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{t("together.loading")}</span>
        </span>
      )}
      {idle && (
        <p role="status" className="absolute inset-x-0 bottom-0 m-2 self-end rounded-full bg-media/75 px-3 py-1.5 text-center text-sm font-medium text-primary-foreground tabular-nums">
          {phase.phase === "before" ? t("together.startsAt", { time: formatTime(phase.startsAtMs) }) : t("together.endedAt", { time: formatTime(phase.endedAtMs) })}
        </p>
      )}
    </div>
  );
}
