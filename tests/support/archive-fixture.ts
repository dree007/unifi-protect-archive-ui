import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/** Real-format file names used across the tests. */
export const CLIP = {
  driveway: "Driveway 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4",
  driveway2: "Driveway 3-29-2026, 1.46.40pm GMT+2 - 3-29-2026, 1.47.21pm GMT+2.mp4",
  garden: "Garden 3-29-2026, 11.20.45am GMT+2 - 3-29-2026, 11.21.04am GMT+2.mp4",
  doorbell: "Doorbell 3-29-2026, 1.01.04pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4",
  nextDay: "Garden 3-30-2026, 7.15.00am GMT+2 - 3-30-2026, 7.15.42am GMT+2.mp4",
} as const;

/**
 * A temporary archive directory, removed after the test file. Files contain a few bytes of
 * placeholder content (never real video) so sizes can be asserted.
 */
export async function createTempArchive(): Promise<TempArchive> {
  const root = await mkdtemp(path.join(tmpdir(), "unifi-archive-test-"));
  afterAll(() => rm(root, { recursive: true, force: true }));
  return new TempArchive(root);
}

export class TempArchive {
  constructor(readonly root: string) {}

  path(relativePath: string): string {
    return path.join(this.root, relativePath);
  }

  /** Writes a file (creating its directory); `size` bytes, optional fixed mtime. */
  async addFile(relativePath: string, { size = 1024, mtime }: { size?: number; mtime?: Date } = {}) {
    const target = this.path(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(size));
    if (mtime) await utimes(target, mtime, mtime);
    return target;
  }

  async mkdir(relativePath: string) {
    await mkdir(this.path(relativePath), { recursive: true });
  }

  async remove(relativePath: string) {
    await rm(this.path(relativePath), { recursive: true, force: true });
  }
}

/** `M-D-YYYY, h.mm.ssam GMT+2` of an instant (fixed offset +2, like summer exports). */
function unifiTimestamp(instant: Date): string {
  const local = new Date(instant.getTime() + 2 * 3_600_000);
  const hour = local.getUTCHours();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${local.getUTCMonth() + 1}-${local.getUTCDate()}-${local.getUTCFullYear()}, ` +
    `${h12}.${two(local.getUTCMinutes())}.${two(local.getUTCSeconds())}${hour < 12 ? "am" : "pm"} GMT+2`
  );
}

/** Relative path `YYYY-MM-DD/<camera> <start> - <end>.mp4` of a synthetic clip (local day folder, +2). */
export function clipPath(camera: string, start: Date, seconds: number): string {
  const end = new Date(start.getTime() + seconds * 1000);
  const day = new Date(start.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
  return `${day}/${camera} ${unifiTimestamp(start)} - ${unifiTimestamp(end)}.mp4`;
}
