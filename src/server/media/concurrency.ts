/** In-process limit for concurrent jobs; further jobs wait in FIFO order. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency limit must be a positive integer.");
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      // Hand the slot directly to the next waiting job (active stays the same), or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
