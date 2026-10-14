// Production build of the command-line entrypoints (docs/background-worker.md,
// docs/selfhosting.md): the background worker and the maintenance commands, each one
// self-contained ESM file in dist/cli/ (+ source map):
//
//   npm run build:cli      → dist/cli/worker-run.mjs, migrate.mjs, archive-scan.mjs, …
//   npm run worker:start   → node --enable-source-maps dist/cli/worker-run.mjs
//
// esbuild (already used by tsx) bundles our TypeScript – `@/` path aliases resolved via
// tsconfig.json – together with its runtime packages (pg, ws, drizzle-orm). The files need
// neither tsx nor node_modules, so the production image only carries the Next.js standalone
// server and these bundles. Bundled with the `react-server` condition, like Next.js server
// code: `server-only` is then an empty module (outside it, it would throw on import).
// Only optional native add-ons stay external; pg and ws work without them.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CLI_ENTRYPOINTS = {
  "worker-run": "scripts/worker-run.mts",
  "worker-health": "scripts/worker-health.mts",
  migrate: "scripts/migrate.mts",
  "archive-scan": "scripts/index-archive.mts",
  "archive-reconcile": "scripts/reconcile-archive.mts",
  "media-check": "scripts/media-check.mts",
  "protect-sync-cameras": "scripts/protect-sync-cameras.mts",
};

const result = await build({
  entryPoints: CLI_ENTRYPOINTS,
  outdir: "dist/cli",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  conditions: ["react-server"],
  external: ["pg-native", "bufferutil", "utf-8-validate"],
  tsconfig: "tsconfig.json",
  sourcemap: true,
  // Bundled CommonJS packages call require(); give the ESM output one.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "warning",
  metafile: true,
});

const packages = new Set<string>();
const dependencies = new Map<string, { name: string; version: string; license: unknown }>();
for (const file of Object.keys(result.metafile.inputs)) {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
  if (match) packages.add(match[1]);
  const marker = file.lastIndexOf("node_modules/");
  if (marker >= 0) {
    const tail = file.slice(marker + "node_modules/".length).split("/");
    const count = tail[0].startsWith("@") ? 2 : 1;
    const directory = file.slice(0, marker + "node_modules/".length) + tail.slice(0, count).join("/");
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    dependencies.set(`${metadata.name}@${metadata.version}`, { name: metadata.name, version: metadata.version, license: metadata.license ?? null });
  }
}
await writeFile("dist/cli/dependencies.json", JSON.stringify([...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2) + "\n");
console.log(
  `Built ${Object.keys(CLI_ENTRYPOINTS).length} entrypoints in dist/cli/; bundled packages: ${[...packages].toSorted().join(", ")}.`,
);
