/**
 * Synchronized playback of two clips of one event ("Gemeinsam abspielen"). One shared position
 * (ms since epoch, recording time) is the only reference; each video shows `position − clip
 * start`. The shared clock runs on a monotonic wall clock while playing and holds while an
 * active video buffers. Videos follow it: small drift is evened out with a slightly changed
 * playback rate, only large drift is corrected by seeking (with a cooldown). Pure TypeScript
 * against a minimal video interface, so it runs in unit tests without a browser.
 *
 * Absolute times come from the clip file names (start/end, second precision). Exported files
 * can run a few seconds longer than that window; a clip therefore stays active until its real
 * media duration ends, once the browser knows it.
 */

export interface TimedClip {
  id: string;
  /** Recording start/end from the file name, ms since epoch. */
  startMs: number;
  endMs: number;
}

export interface Timeline {
  startMs: number;
  endMs: number;
}

export type ClipPhase =
  | { phase: "before"; startsAtMs: number }
  | { phase: "active"; offsetSeconds: number }
  | { phase: "after"; endedAtMs: number };

/** The two clips shown first: the earliest, and preferably one of another camera next to it. */
export function initialPair<T extends { cameraName: string }>(clips: readonly T[]): [T, T] {
  const [first] = clips;
  return [first, clips.find((clip) => clip !== first && clip.cameraName !== first.cameraName) ?? clips[1]];
}

/** The span covered by the clips: earliest start to latest end. */
export function sharedTimeline(clips: readonly TimedClip[]): Timeline {
  return {
    startMs: Math.min(...clips.map((clip) => clip.startMs)),
    endMs: Math.max(...clips.map((clip) => clip.endMs)),
  };
}

export function clampToTimeline(atMs: number, { startMs, endMs }: Timeline): number {
  return Math.min(Math.max(atMs, startMs), endMs);
}

/**
 * Where a clip stands at a shared position. `mediaDurationSeconds` (the real file length, if
 * known) decides the end; otherwise the file name's end does.
 */
export function clipPhase(clip: TimedClip, atMs: number, mediaDurationSeconds?: number): ClipPhase {
  if (atMs < clip.startMs) return { phase: "before", startsAtMs: clip.startMs };
  const lengthMs =
    mediaDurationSeconds !== undefined && Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds > 0
      ? mediaDurationSeconds * 1000
      : clip.endMs - clip.startMs;
  if (atMs >= clip.startMs + lengthMs) return { phase: "after", endedAtMs: clip.startMs + lengthMs };
  return { phase: "active", offsetSeconds: (atMs - clip.startMs) / 1000 };
}

/** Drift handling: tolerated, evened out by playback rate, or corrected by seeking. */
export const DRIFT = {
  /** Up to this many seconds a video counts as in sync (normal rate). */
  toleranceSeconds: 0.12,
  /** Beyond this, catching up by rate would take too long: seek. */
  seekAboveSeconds: 1,
  /** Rate change while catching up (±5 %, barely noticeable). */
  rateNudge: 0.05,
  /** No second correction seek within this time (seeking itself takes a moment). */
  seekCooldownMs: 2000,
} as const;

export type DriftAction = { kind: "rate"; playbackRate: number } | { kind: "seek"; toSeconds: number };

/** What to do about a video at `actualSeconds` that should be at `expectedSeconds`. */
export function driftAction(actualSeconds: number, expectedSeconds: number): DriftAction {
  const drift = actualSeconds - expectedSeconds;
  if (Math.abs(drift) > DRIFT.seekAboveSeconds) return { kind: "seek", toSeconds: expectedSeconds };
  if (Math.abs(drift) <= DRIFT.toleranceSeconds) return { kind: "rate", playbackRate: 1 };
  // Ahead → a little slower, behind → a little faster.
  return { kind: "rate", playbackRate: drift > 0 ? 1 - DRIFT.rateNudge : 1 + DRIFT.rateNudge };
}

/** The part of HTMLVideoElement the controller uses. */
export interface SyncVideo {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

export interface SyncSnapshot {
  positionMs: number;
  playing: boolean;
  timeline: Timeline;
  phases: [ClipPhase, ClipPhase];
}

interface Slot {
  clip: TimedClip;
  video: SyncVideo | null;
  waiting: boolean;
  failed: boolean;
  lastSeekAt: number;
}

export type SlotIndex = 0 | 1;

/**
 * Drives exactly two slots. The caller attaches the video elements, forwards their buffering
 * state and calls {@link tick} regularly while playing (and after every change).
 */
export class SyncController {
  private readonly slots: [Slot, Slot];
  private playing = false;
  private anchorPosition: number;
  private anchorClock: number;
  private audio: SlotIndex | null = null;
  timeline: Timeline;

  constructor(
    clips: readonly [TimedClip, TimedClip],
    private readonly clock: () => number,
    /** Unmuted playback refused by the browser (autoplay policy): audio was switched off. */
    private readonly onAudioBlocked: () => void = () => {},
  ) {
    const slot = (clip: TimedClip): Slot => ({ clip, video: null, waiting: false, failed: false, lastSeekAt: -Infinity });
    this.slots = [slot(clips[0]), slot(clips[1])];
    this.timeline = sharedTimeline(clips);
    this.anchorPosition = this.timeline.startMs;
    this.anchorClock = clock();
  }

  /** Shared position: runs while playing, holds while an active video buffers. */
  position(): number {
    if (!this.playing || this.buffering()) return this.anchorPosition;
    return Math.min(this.anchorPosition + (this.clock() - this.anchorClock), this.timeline.endMs);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  play(): void {
    if (this.playing) return;
    // At the end, play starts over.
    if (this.anchorPosition >= this.timeline.endMs) this.anchorPosition = this.timeline.startMs;
    this.anchorClock = this.clock();
    this.playing = true;
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.reanchor();
    this.playing = false;
    this.tick();
  }

  /** Jumps to a shared position (clamped to the timeline); active videos follow at once. */
  seek(atMs: number): void {
    this.anchorPosition = clampToTimeline(atMs, this.timeline);
    this.anchorClock = this.clock();
    for (const slot of this.slots) slot.lastSeekAt = -Infinity;
    this.tick();
  }

  /** Replaces a slot's clip; the position is kept, or clamped to the new timeline. */
  setClip(index: SlotIndex, clip: TimedClip): void {
    const position = this.position();
    this.slots[index] = { clip, video: null, waiting: false, failed: false, lastSeekAt: -Infinity };
    this.timeline = sharedTimeline(this.slots.map((slot) => slot.clip));
    this.anchorPosition = clampToTimeline(position, this.timeline);
    this.anchorClock = this.clock();
  }

  /** Attaches (or with `null` detaches) the video element of a slot. */
  attach(index: SlotIndex, video: SyncVideo | null): void {
    const slot = this.slots[index];
    this.reanchor();
    slot.video = video;
    slot.waiting = false;
    slot.lastSeekAt = -Infinity;
    if (video) video.muted = this.audio !== index;
    this.tick();
  }

  /** Buffering state of a slot's video (`waiting` → true, `playing`/`canplay` → false). */
  setWaiting(index: SlotIndex, waiting: boolean): void {
    if (this.slots[index].waiting === waiting) return;
    this.reanchor();
    this.slots[index].waiting = waiting;
  }

  /** A slot whose video cannot be played no longer takes part (its error is shown instead). */
  setFailed(index: SlotIndex): void {
    this.reanchor();
    this.slots[index].failed = true;
    this.slots[index].waiting = false;
  }

  /** At most one audible video; `null` mutes both. */
  setAudio(index: SlotIndex | null): void {
    this.audio = index;
    this.slots.forEach((slot, i) => {
      if (slot.video) slot.video.muted = i !== index;
    });
  }

  /** Brings both videos in line with the shared position. Returns the state for the UI. */
  tick(): SyncSnapshot {
    const position = this.position();
    if (this.playing && position >= this.timeline.endMs) {
      this.anchorPosition = this.timeline.endMs;
      this.playing = false;
    }
    const running = this.playing && !this.buffering();
    const now = this.clock();
    const phases = this.slots.map((slot) => {
      const phase = this.phaseOf(slot, position);
      const video = slot.video;
      if (!video || slot.failed) return phase;
      if (phase.phase !== "active") {
        if (!video.paused) video.pause();
        // Waiting for its start: show the first frame.
        if (phase.phase === "before" && video.currentTime !== 0) video.currentTime = 0;
        return phase;
      }
      const expected = phase.offsetSeconds;
      if (!running) {
        if (!video.paused) video.pause();
        // Paused or buffering elsewhere: show the frame of the shared position.
        if (Math.abs(video.currentTime - expected) > DRIFT.toleranceSeconds) video.currentTime = expected;
        return phase;
      }
      if (video.paused) {
        if (Math.abs(video.currentTime - expected) > DRIFT.toleranceSeconds) video.currentTime = expected;
        video.playbackRate = 1;
        this.start(video);
        return phase;
      }
      const action = driftAction(video.currentTime, expected);
      if (action.kind === "seek") {
        if (now - slot.lastSeekAt >= DRIFT.seekCooldownMs) {
          video.currentTime = action.toSeconds;
          video.playbackRate = 1;
          slot.lastSeekAt = now;
        }
      } else if (video.playbackRate !== action.playbackRate) {
        video.playbackRate = action.playbackRate;
      }
      return phase;
    }) as [ClipPhase, ClipPhase];
    return { positionMs: position, playing: this.playing, timeline: this.timeline, phases };
  }

  private phaseOf(slot: Slot, atMs: number): ClipPhase {
    return clipPhase(slot.clip, atMs, slot.video?.duration);
  }

  private start(video: SyncVideo): void {
    video.play().catch((error: unknown) => {
      // Browsers may refuse unmuted playback that does not follow a click: continue muted.
      if (error instanceof Error && error.name === "NotAllowedError" && !video.muted) {
        this.setAudio(null);
        this.onAudioBlocked();
        video.play().catch(() => {});
      }
      // Other failures (aborted by a pause or a source change) need nothing: the next tick decides.
    });
  }

  /** Whether an active, playable video is buffering (the shared clock then holds). */
  private buffering(): boolean {
    return this.slots.some(
      (slot) => slot.waiting && !slot.failed && slot.video && this.phaseOf(slot, this.anchorPosition).phase === "active",
    );
  }

  /** Freezes the current position as the new anchor (before the clock's rules change). */
  private reanchor(): void {
    this.anchorPosition = this.position();
    this.anchorClock = this.clock();
  }
}
