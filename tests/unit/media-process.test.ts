import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory: string;
let bundle: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "unifi-media-process-"));
  bundle = path.join(directory, "signal.mjs");
  await build({ entryPoints: ["tests/support/ffmpeg-signal.mts"], outfile: bundle, bundle: true, platform: "node", format: "esm" });
});
afterAll(() => rm(directory, { recursive: true, force: true }));

describe("media child shutdown", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`reaps a running real ffmpeg after ${signal} without an init wrapper`, async () => {
      const child = spawn(process.execPath, [bundle], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (part) => { output += part.toString(); });
      child.stderr.on("data", (part) => { output += part.toString(); });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      try {
        const deadline = Date.now() + 5_000;
        let children: string[] = [];
        while (Date.now() < deadline) {
          children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
          if (output.includes("rendering") && children.length) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(children.length).toBe(1);
        const started = Date.now();
        child.kill(signal);
        expect(await exit).toBe(0);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(output).toContain("child reaped");
        for (const pid of children) await expect(readFile(`/proc/${pid}/stat`)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        child.kill("SIGKILL");
      }
    });
  }
});
