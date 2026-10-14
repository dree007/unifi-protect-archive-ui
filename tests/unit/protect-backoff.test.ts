import { describe, expect, it } from "vitest";

import { createBackoff } from "@/server/protect/backoff";

describe("reconnect backoff", () => {
  it("doubles from 1 s up to 30 s and stays there", () => {
    const backoff = createBackoff({ random: () => 0.5 }); // 0.5 → no jitter
    expect(Array.from({ length: 8 }, () => backoff.next())).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoff.attempt).toBe(8);
  });

  it("starts over after reset", () => {
    const backoff = createBackoff({ random: () => 0.5 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1000);
  });

  it("adds bounded jitter and never exceeds the maximum", () => {
    const low = createBackoff({ random: () => 0 });
    const high = createBackoff({ random: () => 1 });
    expect(low.next()).toBe(800);
    expect(high.next()).toBe(1200);
    for (let i = 0; i < 10; i++) high.next();
    expect(high.next()).toBe(30_000);
  });
});
