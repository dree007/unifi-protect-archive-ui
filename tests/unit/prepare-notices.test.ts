import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { prepareNotices } from "../../scripts/prepare-notices.mts";

it("preserves exact notice text without copying library code and clears stale generated notices", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-notices-"));
  try {
    await mkdir(path.join(root, "public/notices"), { recursive: true });
    await mkdir(path.join(root, "node_modules/example"), { recursive: true });
    await writeFile(path.join(root, "public/notices/font.txt"), "synthetic font notice\n");
    await writeFile(path.join(root, "node_modules/example/LICENSE"), "synthetic package notice\n");
    await mkdir(path.join(root, "node_modules/example/lib"));
    await writeFile(path.join(root, "node_modules/example/lib/THIRD-PARTY-NOTICES.md"), "synthetic bundled-library notice\n");
    await mkdir(path.join(root, "node_modules/@img/sharp-libvips-synthetic"), { recursive: true });
    await writeFile(path.join(root, "node_modules/@img/sharp-libvips-synthetic/README.md"), "synthetic native license table\n");
    await writeFile(path.join(root, "node_modules/example/package.json"), JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" }));
    await writeFile(path.join(root, "node_modules/example/index.js"), "private library code");
    await prepareNotices(root);
    expect(await readFile(path.join(root, "dist/notices/npm/example/LICENSE"), "utf8")).toBe("synthetic package notice\n");
    expect(await readFile(path.join(root, "dist/notices/npm/example/lib/THIRD-PARTY-NOTICES.md"), "utf8")).toBe("synthetic bundled-library notice\n");
    expect(await readFile(path.join(root, "dist/notices/npm/@img/sharp-libvips-synthetic/README.md"), "utf8")).toBe("synthetic native license table\n");
    await expect(readFile(path.join(root, "dist/notices/npm/example/index.js"))).rejects.toThrow();
    await writeFile(path.join(root, "dist/notices/stale.txt"), "obsolete");
    await prepareNotices(root);
    await expect(readFile(path.join(root, "dist/notices/stale.txt"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
