export interface BackoffOptions {
  /** First delay (default 1 s); doubles per attempt. */
  initialMs?: number;
  /** Upper bound (default 30 s). */
  maxMs?: number;
  /** ± share of random jitter (default 0.2 = ±20 %), so restarts do not reconnect in lockstep. */
  jitterRatio?: number;
  random?: () => number;
}

/** Exponential reconnect backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, … (plus jitter). */
export function createBackoff({ initialMs = 1000, maxMs = 30_000, jitterRatio = 0.2, random = Math.random }: BackoffOptions = {}) {
  let attempt = 0;
  return {
    next(): number {
      const base = Math.min(maxMs, initialMs * 2 ** attempt);
      attempt++;
      const jitter = base * jitterRatio * (random() * 2 - 1);
      return Math.round(Math.min(maxMs, Math.max(0, base + jitter)));
    },
    reset(): void {
      attempt = 0;
    },
    get attempt(): number {
      return attempt;
    },
  };
}
