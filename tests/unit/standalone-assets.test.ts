import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/prepare-standalone.mts");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "unifi-standalone-assets-"));
  fixtures.push(root);
  await mkdir(path.join(root, ".next/static/chunks"), { recursive: true });
  await writeFile(path.join(root, ".next/static/chunks/app.js"), "synthetic static asset");
  return root;
}

const prepare = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });

describe("standalone assets in fresh checkouts", () => {
  it("builds without an optional public directory, as in a fresh Git/CI checkout", async () => {
    const root = await fixture();
    expect(prepare(root).status).toBe(0);
    expect(await readdir(path.join(root, "public"))).toEqual([]);
    expect(await readdir(path.join(root, ".next/standalone/public"))).toEqual([]);
    expect(await readFile(path.join(root, ".next/standalone/.next/static/chunks/app.js"), "utf8"))
      .toBe("synthetic static asset");
  });

  it("preserves public assets when present", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public/icons"), { recursive: true });
    await writeFile(path.join(root, "public/icons/example.svg"), "synthetic public asset");
    expect(prepare(root).status).toBe(0);
    expect(await readFile(path.join(root, ".next/standalone/public/icons/example.svg"), "utf8"))
      .toBe("synthetic public asset");
  });

  it("still fails if required Next.js static build output is missing", async () => {
    const root = await fixture();
    await rm(path.join(root, ".next/static"), { recursive: true });
    const result = prepare(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(".next/static");
  });
});
