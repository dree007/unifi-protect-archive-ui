import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dscFiles } from "./collect-native-sources.mts";
import { fileDigest, releaseVersion } from "./metadata.mts";
import { digest, regularFile } from "./source.mts";

export interface MaterialFile { path: string; sha256: string; size: number }
export interface SourcePackage {
  name: string; version: string; descriptor: string; files: MaterialFile[];
  buildFiles: MaterialFile[]; extraction: "PASS"; signature: "PASS" | "NOT VERIFIED";
}
export interface RuntimeComponent {
  name: string; version: string; type: string; architecture: string;
  location: string | null;
  source: string | null; sourceVersion: string | null; license: string;
  notices: MaterialFile[]; sources: string[]; sourceObligation: "required" | "supplementary" | "review";
  evidence: string; status: "PASS" | "LEGAL REVIEW REQUIRED";
}
export interface NativeManifest {
  schema: 2; version: string; platform: "linux/amd64"; imageId: string;
  applicationSourceSha256: string; runtimeSha256: string;
  components: RuntimeComponent[]; sourcePackages: SourcePackage[];
  materials: MaterialFile[]; buildInfo: MaterialFile[];
  publication: { status: "NOT TESTED"; intendedUrl: string };
}
export interface NativeValidation {
  schema: 2; imageId: string; version: string; applicationSourceSha256: string;
  manifestSha256: string; runtimeSha256: string;
  technical: "PASS"; compliance: "PASS" | "LEGAL REVIEW REQUIRED";
  issues: string[]; files: number; bytes: number;
}

export async function run(command: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${diagnostic.trim()}`)));
  });
}

export async function extractNativeArchive(archive: string, destination: string) {
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split("\n");
  for (const entry of names) {
    const name = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (name && name !== ".") materialPath(name);
  }
  const types = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split("\n");
  if (types.some((entry) => !/^[d-]/.test(entry))) throw new Error("Release source archives may not contain links or special files.");
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xzf", archive, "--no-same-owner", "-C", destination]);
}

export function materialPath(name: string) {
  if (!name || path.isAbsolute(name) || name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid source material path.");
  if (/(^|\/)\.git(?:\/|$)|(^|\/)\.env(?:\.|$)/.test(name)) throw new Error("Private workspace material is not a release source.");
  return name;
}

async function verifyFile(root: string, file: MaterialFile) {
  materialPath(file.path);
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid source checksum record.");
  // Resolve/reject symlinks without reading a large archive into memory.
  const { lstat, realpath } = await import("node:fs/promises");
  const target = path.join(root, file.path);
  if (!(await lstat(target)).isFile() || !(await realpath(target)).startsWith((await realpath(root)) + path.sep)) throw new Error("Source material escapes the bundle.");
  if ((await stat(target)).size !== file.size || await fileDigest(target) !== file.sha256) throw new Error(`Source checksum mismatch: ${file.path}`);
}

export async function verifySourcePackage(root: string, source: SourcePackage, checkArchives = true) {
  if (source.extraction !== "PASS" || !source.files.length || !source.buildFiles.some((file) => /\/debian\/rules$/.test(file.path)) || !source.buildFiles.some((file) => /\/debian\/changelog$/.test(file.path))) throw new Error(`Missing verified packaging/build material: ${source.name}`);
  const descriptor = source.files.find((file) => file.path === source.descriptor);
  if (!descriptor) throw new Error("Source descriptor is missing from its inventory.");
  const entries = dscFiles((await regularFile(root, source.descriptor)).toString(), source.name, source.version);
  const directory = path.posix.dirname(source.descriptor);
  if (entries.length + 1 !== source.files.length) throw new Error("Incomplete or extra Debian source archives.");
  for (const entry of entries) {
    const found = source.files.find((file) => file.path === `${directory}/${entry.path}`);
    if (!found || found.sha256 !== entry.sha256 || found.size !== entry.size) throw new Error(`Source descriptor/archive mismatch: ${source.name}`);
  }
  for (const file of [...source.files, ...source.buildFiles]) await verifyFile(root, file);
  if (checkArchives) for (const file of source.files) {
    if (/\.tar(?:\.(?:gz|xz|bz2|zst))?$/.test(file.path)) await run("tar", ["-tf", path.join(root, file.path)]);
    else if (/\.diff\.gz$/.test(file.path)) await run("gzip", ["-t", path.join(root, file.path)]);
  }
  if (checkArchives) {
    const temporary = await mkdtemp(path.join(tmpdir(), "unifi-debian-source-"));
    try {
      const extracted = path.join(temporary, "source");
      await run("dpkg-source", ["--no-check", "-x", path.join(root, source.descriptor), extracted]);
      for (const file of source.buildFiles) {
        const name = file.path.slice(file.path.lastIndexOf("/debian/") + 1);
        if (await fileDigest(path.join(extracted, name)) !== file.sha256) throw new Error(`Build material differs from the exact source archive: ${source.name}`);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

async function filesBelow(root: string, directory = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesBelow(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error("Source bundles may contain only regular files and directories.");
  }
  return result;
}

export async function validateNativeBundle(root: string, expected?: { imageId: string; version: string; applicationSourceSha256: string; runtimeSha256?: string }, checkArchives = true): Promise<NativeValidation> {
  const manifest: NativeManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schema !== 2 || manifest.platform !== "linux/amd64" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId) || !/^[a-f0-9]{64}$/.test(manifest.applicationSourceSha256)) throw new Error("Invalid native source manifest identity.");
  releaseVersion(manifest.version);
  if (expected && (expected.imageId !== manifest.imageId || expected.version !== manifest.version || expected.applicationSourceSha256 !== manifest.applicationSourceSha256)) throw new Error("Native sources belong to another image/release.");
  if (expected?.runtimeSha256 && expected.runtimeSha256 !== manifest.runtimeSha256) throw new Error("Fresh image inventory differs from the bundle inventory.");
  const materials = manifest.materials;
  if (!materials.length || new Set(materials.map((file) => file.path)).size !== materials.length || !manifest.components.length || !manifest.sourcePackages.length || !manifest.buildInfo.length) throw new Error("Incomplete native component/material inventory.");
  for (const file of materials) await verifyFile(root, file);
  const byPath = new Map(materials.map((file) => [file.path, file]));
  const requireMaterial = (file: MaterialFile) => {
    if (!byPath.has(file.path) || JSON.stringify(byPath.get(file.path)) !== JSON.stringify(file)) throw new Error("Component evidence is not in the source manifest.");
  };
  manifest.buildInfo.forEach(requireMaterial);
  const sources = new Map(manifest.sourcePackages.map((source) => [`${source.name}=${source.version}`, source]));
  if (sources.size !== manifest.sourcePackages.length) throw new Error("Duplicate Debian source identity.");
  for (const source of sources.values()) {
    [...source.files, ...source.buildFiles].forEach(requireMaterial);
    await verifySourcePackage(root, source, checkArchives);
  }
  for (const component of manifest.components) {
    if (!component.name || !component.version || !component.license || !component.evidence || !component.notices.length || !["PASS", "LEGAL REVIEW REQUIRED"].includes(component.status)) throw new Error("Unclassified runtime component or missing notice.");
    component.notices.forEach(requireMaterial);
    component.sources.forEach((name) => { if (!byPath.has(name)) throw new Error("Component source material is missing."); });
    if (component.type === "deb") {
      const source = sources.get(`${component.source}=${component.sourceVersion}`);
      if (!source || !source.files.every((file) => component.sources.includes(file.path))) throw new Error(`Debian binary/source version mismatch: ${component.name}`);
    } else if (component.sourceObligation === "required" && !component.sources.length) throw new Error(`Required source is missing: ${component.name}`);
  }
  const runtimeFile = materials.find((file) => file.path === "runtime-inventory.json");
  if (!runtimeFile || runtimeFile.sha256 !== manifest.runtimeSha256) throw new Error("Runtime inventory identity mismatch.");
  const runtime = JSON.parse(await readFile(path.join(root, runtimeFile.path), "utf8"));
  const deb = manifest.components.filter((component) => component.type === "deb");
  if (runtime.packages.length !== deb.length || runtime.packages.some((item: { name: string; version: string; source: string; sourceVersion: string; copyrightSha256: string }) => !deb.some((component) => component.name === item.name && component.version === item.version && component.source === item.source && component.sourceVersion === item.sourceVersion && component.notices.some((notice) => notice.sha256 === item.copyrightSha256)))) throw new Error("Runtime inventory has unassigned or substituted Debian components.");
  const npm = manifest.components.filter((component) => component.type === "npm");
  if (runtime.npm.length !== npm.length || runtime.npm.some((item: { name: string; version: string; directory: string }) => !npm.some((component) => component.name === item.name && component.version === item.version && component.location === item.directory))) throw new Error("Runtime inventory has unassigned npm components.");
  for (const item of runtime.compiledDependencies ?? []) {
    if (!manifest.components.some((component) => component.name === item.name && component.version === item.version)) throw new Error("Unassigned compiled dependency.");
  }
  for (const [name, version] of Object.entries(runtime.node?.components ?? {})) {
    if (!version || ["node", "modules", "napi", "unicode"].includes(name)) continue;
    if (!manifest.components.some((component) => component.name === `node:${name}` && component.version === version && component.type === "node-bundled")) throw new Error("Unassigned bundled Node component.");
  }
  for (const binary of runtime.binaries as { path: string }[]) {
    if (!manifest.components.some((component) => component.location === binary.path || (component.location && binary.path.startsWith(component.location + "/")))) throw new Error("Unassigned native executable/library.");
  }
  for (const font of runtime.fonts ?? []) {
    if (!manifest.components.some((component) => component.location === font.path && component.version === `sha256:${font.sha256}` && component.type === "font")) throw new Error("Unassigned or substituted font asset.");
  }
  const expectedFiles = new Set([...materials.map((file) => file.path), "manifest.json", "SHA256SUMS"]);
  const actual = await filesBelow(root);
  if (actual.length !== expectedFiles.size || actual.some((file) => !expectedFiles.has(file))) throw new Error("Unlisted/private material in native bundle.");
  const sums = (await readFile(path.join(root, "SHA256SUMS"), "utf8")).trim().split("\n");
  const expectedSums = [...materials, { path: "manifest.json", sha256: await fileDigest(path.join(root, "manifest.json")) }].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.sha256}  ${file.path}`);
  if (JSON.stringify(sums) !== JSON.stringify(expectedSums)) throw new Error("SHA256SUMS does not match the complete source manifest.");
  const issues = manifest.components.filter((component) => component.status !== "PASS").map((component) => `${component.name}@${component.version}: ${component.evidence}`);
  return { schema: 2, imageId: manifest.imageId, version: manifest.version, applicationSourceSha256: manifest.applicationSourceSha256, manifestSha256: await fileDigest(path.join(root, "manifest.json")), runtimeSha256: manifest.runtimeSha256, technical: "PASS", compliance: issues.length ? "LEGAL REVIEW REQUIRED" : "PASS", issues, files: actual.length, bytes: materials.reduce((sum, file) => sum + file.size, 0) };
}

export async function writeChecksumManifest(root: string, manifest: NativeManifest) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const files = [...manifest.materials, { path: "manifest.json", sha256: await fileDigest(path.join(root, "manifest.json")), size: 0 }].sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(path.join(root, "SHA256SUMS"), files.map((file) => `${file.sha256}  ${file.path}`).join("\n") + "\n");
}

export function canonicalRuntime<T>(raw: T): T {
  return JSON.parse(JSON.stringify(raw, (key, value) => {
    if (key === "text") return undefined;
    if (typeof value === "string") return value.replace(/\s*\(0x[\da-f]+\)/g, "");
    return value;
  }));
}

export function inspectRuntime(image: string) {
  const probe = path.resolve(import.meta.dirname, "runtime-probe.mjs");
  return JSON.parse(execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, "--entrypoint", "node", image, "/probe.mjs"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

export function runtimeIdentity(runtime: unknown) { return digest(JSON.stringify(canonicalRuntime(runtime), null, 2) + "\n"); }
