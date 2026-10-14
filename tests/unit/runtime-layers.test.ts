import { describe, expect, it } from "vitest";
import { excludedRuntimePath } from "../../scripts/release/layers.mts";

describe("distributed runtime layer policy", () => {
  it.each(["usr/local/lib/node_modules/npm/node_modules/@npmcli/agent/package.json", "app/node_modules/@npmcli/agent/package.json", "./usr/local/bin/npx", "usr/local/lib/node_modules/corepack/package.json", "app/node_modules/sharp/package.json", "app/node_modules/@img/sharp-linux-x64/lib/sharp.node"])("rejects %s even in an older layer", (name) => expect(excludedRuntimePath(name)).toBe(true));
  it.each(["usr/local/bin/node", "app/notices/npm/next/license.md", "app/node_modules/next/package.json", "usr/bin/ffmpeg"])("preserves %s", (name) => expect(excludedRuntimePath(name)).toBe(false));
});
