import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileDigest } from "./metadata.mts";
import { type NativeManifest } from "./native-compliance.mts";

const root = path.resolve(process.env.NATIVE_BUNDLE_DIRECTORY ?? ".cache/release-sources");
const manifest: NativeManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const sourceByPath = new Map(manifest.sourcePackages.flatMap((source) => [...source.files, ...source.buildFiles].map((file) => [file.path, source.name] as const)));
function category(name: string) {
  if (name.startsWith("debian/")) return ["ffmpeg", "x264", "x265", "aom", "dav1d", "lame", "opus", "libvpx"].includes(sourceByPath.get(name) ?? "") ? "FFmpeg/codecs (Debian subset)" : "Other Debian sources";
  if (name.startsWith("node/")) return name.includes("node-v") ? "Node/V8" : "npm sources";
  if (name.startsWith("licenses/")) return "License texts";
  if (name.startsWith("build-info/")) return "Build information";
  return "Other";
}
const files = [];
for (const file of manifest.materials) {
  const target = path.join(root, file.path);
  if ((await stat(target)).size !== file.size || await fileDigest(target) !== file.sha256) throw new Error(`Changed audit input: ${file.path}`);
  files.push({ ...file, category: category(file.path), source: sourceByPath.get(file.path) ?? null });
}
const groups = new Map<string, typeof files>();
for (const file of files) groups.set(file.sha256, [...(groups.get(file.sha256) ?? []), file]);
const categories: Record<string, { files: number; storedBytes: number }> = {};
for (const file of files) {
  const group = categories[file.category] ??= { files: 0, storedBytes: 0 };
  group.files++; group.storedBytes += file.size;
}
const report = {
  imageId: manifest.imageId, materialFiles: files.length, storedBytes: files.reduce((sum, file) => sum + file.size, 0),
  // These are stored payload bytes, not fabricated shares of the outer compressed stream.
  categories, top30: files.toSorted((a, b) => b.size - a.size).slice(0, 30),
  top20Sources: manifest.sourcePackages.map((source) => ({ name: source.name, version: source.version,
    storedBytes: [...source.files, ...source.buildFiles].reduce((sum, file) => sum + file.size, 0),
    components: manifest.components.filter((item) => item.source === source.name).map((item) => ({ name: item.name, license: item.license, obligation: item.sourceObligation }))
  })).toSorted((a, b) => b.storedBytes - a.storedBytes).slice(0, 20),
  duplicates: [...groups.values()].filter((group) => group.length > 1).map((group) => ({ paths: group.map((file) => file.path), sha256: group[0].sha256, redundantBytes: (group.length - 1) * group[0].size }))
};
const output = path.resolve(process.env.NATIVE_AUDIT_OUTPUT ?? ".cache/bundle-audit.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Audited ${files.length} materials; report: ${output}`);
