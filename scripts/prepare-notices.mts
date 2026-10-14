import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preserve installed dependency notice files that bundling/tracing may otherwise omit.
 * Includes build-tool notices as a conservative superset, without copying third-party code.
 */
export async function prepareNotices(root = process.cwd()) {
  const destination = path.join(root, "dist/notices");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(path.join(root, "public/notices"), path.join(destination, "assets"), { recursive: true });
  const packages: { name: string; version: string; license: unknown; path: string }[] = [];
  let files = 0;
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(source);
      } else if (entry.name === "package.json") {
        const metadata = JSON.parse(await readFile(source, "utf8"));
        if (metadata.name) packages.push({ name: metadata.name, version: metadata.version ?? "not declared", license: metadata.license ?? "not declared", path: path.relative(root, directory) });
      } else if (/^(?:licen[sc]e|notice|copying|copyright|third[-_]party[-_]notices)(?:[._-].*)?$/i.test(entry.name)
        || (entry.name === "README.md" && /^@img\/sharp-libvips-[^/]+$/.test(path.relative(path.join(root, "node_modules"), directory)))) {
        const target = path.join(destination, "npm", path.relative(path.join(root, "node_modules"), source));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target);
        files++;
      }
    }
  }
  await visit(path.join(root, "node_modules"));
  packages.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(path.join(destination, "packages.json"), JSON.stringify(packages, null, 2) + "\n");
  const frontend = new Set<string>();
  async function imports(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await imports(file);
      else if (/\.(?:tsx?|css)$/.test(entry.name)) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(/(?:from\s+|import\s+)["']([^"']+)["']/g)) {
          if (match[1].startsWith(".") || match[1].startsWith("@/") || match[1].startsWith("node:")) continue;
          const parts = match[1].split("/");
          const name = parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
          if (packages.some((item) => item.name === name)) frontend.add(name);
        }
      }
    }
  }
  // Notice-only unit fixtures need no application source directory.
  try { await imports(path.join(root, "src")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(path.join(destination, "frontend-dependencies.json"), JSON.stringify(packages.filter((item) => frontend.has(item.name) && item.path === `node_modules/${item.name}`), null, 2) + "\n");
  console.log(`Preserved ${files} npm notice files and asset notices in dist/notices.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await prepareNotices();
