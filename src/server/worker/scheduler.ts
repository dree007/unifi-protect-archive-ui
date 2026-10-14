/**
 * Tiny in-process scheduler for the worker's periodic jobs (docs/background-worker.md):
 *
 * - one controlled async loop per job, at most one pending timer each (no setInterval),
 * - single flight: a job never overlaps itself,
 * - fixed delay: the next run is due one interval after the previous run *finished* – a scan
 *   that takes longer than its interval delays the next one instead of piling up, and missed
 *   intervals are never caught up,
 * - coalescing: any number of triggers while a run is waiting or running lead to at most one
 *   further run,
 * - jobs sharing a {@link Mutex} never run at the same time (NAS scan ↔ reconciliation),
 * - abort: no new runs start; the loop ends after the current run returned.
 */

/** FIFO async lock. `acquire` resolves with a release function, or `null` if aborted while waiting. */
export class Mutex {
  private locked = false;
  private readonly waiters: ((release: () => void) => void)[] = [];

  get isLocked(): boolean {
    return this.locked;
  }

  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const waiter = (release: () => void) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaser());
      else this.locked = false;
    };
  }
}

export interface PeriodicJobOptions {
  name: string;
  intervalMs: number;
  /** Should handle its own errors; anything thrown is passed to `onError` and the loop goes on. */
  run: (signal: AbortSignal) => Promise<void>;
  /** `immediately`: first run right after start; `afterInterval`: one interval after start. */
  firstRun: "immediately" | "afterInterval";
  /** Shared with other jobs that must not run at the same time. */
  mutex?: Mutex;
  /** Called whenever the next regular run time is (re)planned. */
  onScheduled?: (nextRunAt: Date) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class PeriodicJob {
  private requested = false;
  private wake: (() => void) | undefined;
  private active = false;
  private runs = 0;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: PeriodicJobOptions) {}

  get name(): string {
    return this.options.name;
  }

  /** True while the job body executes (not while waiting for the mutex). */
  get isRunning(): boolean {
    return this.active;
  }

  /** Number of completed runs (for tests and logs). */
  get completedRuns(): number {
    return this.runs;
  }

  /** Starts the loop; resolves when it ended after `signal` was aborted. */
  start(signal: AbortSignal): Promise<void> {
    this.loop ??= this.runLoop(signal);
    return this.loop;
  }

  /** Requests a run as soon as possible; coalesced with other pending requests. */
  trigger(): void {
    this.requested = true;
    this.wake?.();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const { intervalMs, run, mutex, onScheduled, onError, now = Date.now } = this.options;
    let dueAt = this.options.firstRun === "immediately" ? now() : now() + intervalMs;
    while (!signal.aborted) {
      if (!this.requested) onScheduled?.(new Date(dueAt));
      await this.waitUntil(dueAt, signal, now);
      if (signal.aborted) break;

      const release = mutex ? await mutex.acquire(signal) : () => {};
      if (!release) break;
      // Cleared only now: triggers that arrived while waiting for the mutex are served by
      // this very run; triggers during the run cause exactly one more run.
      this.requested = false;
      this.active = true;
      try {
        await run(signal);
      } catch (error) {
        onError?.(error);
      } finally {
        this.active = false;
        this.runs++;
        release();
      }
      dueAt = now() + intervalMs;
    }
  }

  private waitUntil(dueAt: number, signal: AbortSignal, now: () => number): Promise<void> {
    if (this.requested || signal.aborted) return Promise.resolve();
    const delay = Math.max(0, dueAt - now());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }
}
