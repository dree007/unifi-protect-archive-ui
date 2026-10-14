import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Mutex, PeriodicJob } from "@/server/worker/scheduler";

const MIN = 60_000;

/** A job body that records start/end times and can be made slow. */
function recorder(durationMs = () => 0) {
  const runs: { start: number; end?: number }[] = [];
  let active = 0;
  let maxActive = 0;
  const run = async () => {
    const entry: { start: number; end?: number } = { start: Date.now() };
    runs.push(entry);
    active++;
    maxActive = Math.max(maxActive, active);
    const ms = durationMs();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    active--;
    entry.end = Date.now();
  };
  return { runs, run, get maxActive() { return maxActive; } };
}

/** Scan + reconciliation wired like in the worker. */
function workerJobs({
  runOnStartup = true,
  scanMs = (): number => 0,
  reconcileMs = (): number => 0,
}: { runOnStartup?: boolean; scanMs?: () => number; reconcileMs?: () => number } = {}) {
  const mutex = new Mutex();
  const scanRec = recorder(scanMs);
  const reconcileRec = recorder(reconcileMs);
  const reconcile = new PeriodicJob({ name: "reconcile", intervalMs: 5 * MIN, firstRun: "afterInterval", mutex, run: reconcileRec.run });
  const scan = new PeriodicJob({
    name: "scan",
    intervalMs: 15 * MIN,
    firstRun: runOnStartup ? "immediately" : "afterInterval",
    mutex,
    run: async () => {
      await scanRec.run();
      reconcile.trigger();
    },
  });
  const controller = new AbortController();
  const loops = [scan.start(controller.signal), reconcile.start(controller.signal)];
  return { scan, reconcile, scanRec, reconcileRec, controller, loops };
}

const minutes = (runs: { start: number }[], t0: number) => runs.map((r) => (r.start - t0) / MIN);

describe("worker scheduler", () => {
  let t0: number;
  beforeEach(() => {
    vi.useFakeTimers();
    t0 = Date.now();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the start-up scan at once, then the reconciliation right after it", async () => {
    const { scanRec, reconcileRec, controller, loops } = workerJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(minutes(scanRec.runs, t0)).toEqual([0]);
    expect(minutes(reconcileRec.runs, t0)).toEqual([0]);
    controller.abort();
    await Promise.all(loops);
  });

  it("without start-up run, the first scan comes one interval later", async () => {
    const { scanRec, reconcileRec, controller, loops } = workerJobs({ runOnStartup: false });
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(scanRec.runs).toHaveLength(0);
    // The reconciliation runs on its own interval meanwhile.
    expect(minutes(reconcileRec.runs, t0)).toEqual([5, 10]);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(minutes(scanRec.runs, t0)).toEqual([15]);
    controller.abort();
    await Promise.all(loops);
  });

  it("repeats scans and reconciliations at their intervals", async () => {
    const { scanRec, reconcileRec, controller, loops } = workerJobs();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(minutes(scanRec.runs, t0)).toEqual([0, 15, 30]);
    // 0 (after scan), 5, 10, 15 (after scan; the regular one is re-planned from there), 20, 25, 30.
    expect(minutes(reconcileRec.runs, t0)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    controller.abort();
    await Promise.all(loops);
  });

  it("a long scan neither overlaps itself nor lets reconciliations pile up behind it", async () => {
    // First scan takes 20 minutes – longer than its 15-minute interval.
    let first = true;
    const { scanRec, reconcileRec, controller, loops } = workerJobs({
      scanMs: () => {
        const ms = first ? 20 * MIN : 1000;
        first = false;
        return ms;
      },
    });
    await vi.advanceTimersByTimeAsync(21 * MIN);
    // No second scan at 15: the next is due 15 minutes after the first one *ended* (at 35).
    expect(minutes(scanRec.runs, t0)).toEqual([0]);
    expect(scanRec.maxActive).toBe(1);
    // Reconciliations due at 5, 10, 15 and the scan trigger collapse into one run at 20.
    expect(minutes(reconcileRec.runs, t0)).toEqual([20]);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(minutes(scanRec.runs, t0)).toEqual([0, 35]);
    controller.abort();
    await Promise.all(loops);
  });

  it("never runs scan and reconciliation at the same time", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const mutex = new Mutex();
    const body = (ms: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, ms));
      concurrent--;
    };
    const a = new PeriodicJob({ name: "a", intervalMs: 7000, firstRun: "immediately", mutex, run: body(5000) });
    const b = new PeriodicJob({ name: "b", intervalMs: 3000, firstRun: "immediately", mutex, run: body(4000) });
    const controller = new AbortController();
    const loops = [a.start(controller.signal), b.start(controller.signal)];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(maxConcurrent).toBe(1);
    expect(a.completedRuns).toBeGreaterThan(5);
    expect(b.completedRuns).toBeGreaterThan(5);
    controller.abort();
    // The run in progress finishes first.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(loops);
  });

  it("coalesces many triggers into one more run, also during a running reconciliation", async () => {
    const rec = recorder(() => 1000);
    const job = new PeriodicJob({ name: "r", intervalMs: 5 * MIN, firstRun: "afterInterval", run: rec.run });
    const controller = new AbortController();
    const loop = job.start(controller.signal);
    job.trigger();
    job.trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(rec.runs).toHaveLength(1);
    // While it runs: five triggers → exactly one follow-up run, never two in parallel.
    for (let i = 0; i < 5; i++) job.trigger();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.runs).toHaveLength(2);
    expect(rec.maxActive).toBe(1);
    controller.abort();
    await loop;
  });

  it("does not catch up missed intervals (e.g. after the process was suspended)", async () => {
    const rec = recorder();
    const job = new PeriodicJob({ name: "r", intervalMs: 5 * MIN, firstRun: "immediately", run: rec.run });
    const controller = new AbortController();
    const loop = job.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    // Clock jumps 2 hours ahead without timers firing in between.
    vi.setSystemTime(Date.now() + 120 * MIN);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(rec.runs).toHaveLength(2);
    controller.abort();
    await loop;
  });

  it("stops: no new runs, no pending timers, the running job finishes first", async () => {
    const rec = recorder(() => 3000);
    const job = new PeriodicJob({ name: "r", intervalMs: 1000, firstRun: "immediately", run: rec.run });
    const controller = new AbortController();
    const loop = job.start(controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.isRunning).toBe(true);
    controller.abort();
    let ended = false;
    void loop.then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ended).toBe(true);
    expect(rec.runs).toHaveLength(1);
    expect(rec.runs[0].end).toBeDefined();
    job.trigger();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps going after a failing run and reports the error", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const job = new PeriodicJob({
      name: "r",
      intervalMs: 1000,
      firstRun: "immediately",
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });
    const controller = new AbortController();
    const loop = job.start(controller.signal);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    controller.abort();
    await loop;
  });

  it("reports every planned run time", async () => {
    const planned: number[] = [];
    const job = new PeriodicJob({
      name: "r",
      intervalMs: 5 * MIN,
      firstRun: "afterInterval",
      run: async () => {},
      onScheduled: (at) => planned.push((at.getTime() - t0) / MIN),
    });
    const controller = new AbortController();
    const loop = job.start(controller.signal);
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(planned).toEqual([5, 10, 15]);
    controller.abort();
    await loop;
  });
});

describe("Mutex", () => {
  it("serves waiters in order and drops aborted ones", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const first = await mutex.acquire();
    const controller = new AbortController();
    const second = mutex.acquire(controller.signal);
    const third = mutex.acquire().then((release) => {
      order.push("third");
      return release;
    });
    controller.abort();
    expect(await second).toBeNull();
    first!();
    (await third)!();
    expect(order).toEqual(["third"]);
    expect(mutex.isLocked).toBe(false);
  });
});
