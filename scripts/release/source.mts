import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkPublication, isPublicPath } from "../publication-check.mts";

export interface SourceFile { path: string; sha256: string; gitBlobSha1: string; executable: boolean }

export function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function regularFile(root: string, name: string): Promise<Buffer> {
  const file = path.resolve(root, name);
  const base = await realpath(root);
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !(await realpath(file)).startsWith(base + path.sep)) {
    throw new Error("Release file escapes its source directory.");
  }
  if (!(await lstat(file)).isFile()) throw new Error(`Release files must be regular files: ${name}`);
  return readFile(file);
}

/** A content export only: never copies private Git history or initializes another repository. */
export async function exportSource(root: string, output: string, suppliedFiles?: string[]) {
  const candidates = suppliedFiles ?? execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const names = [...new Set(candidates.filter((name) => name && isPublicPath(name)))].sort();
  const result = await checkPublication(root, names);
  if (result.findings.length) throw new Error(`Public source check failed: ${result.findings.map((entry) => entry.file).join(", ")}`);
  const snapshot = path.join(output, "source");
  if (path.resolve(snapshot) === path.resolve(root)) throw new Error("Cannot replace the source directory.");
  const files: SourceFile[] = [];
  // Validate every file before replacing a previous disposable export.
  for (const name of names) {
    const content = await regularFile(root, name);
    const gitBlobSha1 = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    files.push({ path: name, sha256: digest(content), gitBlobSha1, executable: !!((await lstat(path.join(root, name))).mode & 0o111) });
  }
  await mkdir(output, { recursive: true });
  await rm(snapshot, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(snapshot, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file.path), target);
    await chmod(target, file.executable ? 0o755 : 0o644);
    if (digest(await readFile(target)) !== file.sha256) throw new Error("Source changed while exporting; retry from a frozen revision.");
  }
  const sha256 = digest(JSON.stringify(files));
  await writeFile(path.join(output, "source-files.json"), JSON.stringify({ sha256, files }, null, 2) + "\n");
  return { snapshot, sha256, files };
}

/** source-files.json of a release directory, accepted only if it is the image's source identity. */
export async function releaseSourceFiles(directory: string, sourceSha256: string): Promise<SourceFile[]> {
  const listing: { sha256: string; files: SourceFile[] } = JSON.parse(await readFile(path.join(directory, "source-files.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || listing.sha256 !== sourceSha256 || digest(JSON.stringify(listing.files)) !== sourceSha256) {
    throw new Error("source-files.json does not match the release source identity.");
  }
  return listing.files;
}

/**
 * Path of an application file in the release source snapshot (`<directory>/source`), checked against
 * source-files.json and thus against the source identity the release image carries.
 */
export async function verifiedSourceFile(directory: string, sourceSha256: string, name: string) {
  const entry = (await releaseSourceFiles(directory, sourceSha256)).find((file) => file.path === name);
  if (!entry) throw new Error(`${name} is not part of the release source.`);
  let content: Buffer;
  try {
    content = await regularFile(path.join(directory, "source"), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`The release source snapshot ${path.join(directory, "source")} lacks ${name}. It is not a job artifact: restore it from source.tar.gz with "node scripts/release/source.mts restore ${directory}".`);
  }
  if (digest(content) !== entry.sha256) throw new Error(`${name} in the release source snapshot differs from source-files.json.`);
  return path.join(directory, "source", name);
}

/**
 * Restores `<directory>/source` in a later release job from the release-build artifact source.tar.gz.
 * The archive must match release.json, may hold only directories and regular files, and must contain
 * exactly the files of source-files.json with their recorded content and mode. Nothing else is used.
 */
export async function restoreSource(directory: string) {
  const release: { source: { sha256: string; archiveSha256: string } } = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8"));
  const archive = path.join(directory, "source.tar.gz");
  let archiveContent: Buffer;
  try {
    archiveContent = await readFile(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`${archive} is missing; it must come from the release-build job artifacts.`);
  }
  if (digest(archiveContent) !== release.source.archiveSha256) throw new Error("source.tar.gz differs from release.json.");
  const files = await releaseSourceFiles(directory, release.source.sha256);
  const expected = new Map(files.map((file) => [file.path, file]));
  const tar = (flags: string) => execFileSync("tar", [flags, archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd().split("\n");
  const names = tar("-tzf"), types = tar("-tvzf");
  if (names.length !== types.length) throw new Error("source.tar.gz has an unreadable entry list.");
  const seen = new Set<string>();
  names.forEach((entry, index) => {
    const name = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (types[index].startsWith("d")) return;
    if (!types[index].startsWith("-") || !expected.has(name) || seen.has(name)) throw new Error(`source.tar.gz contains an unexpected entry: ${entry}`);
    seen.add(name);
  });
  if (seen.size !== expected.size) throw new Error("source.tar.gz lacks files listed in source-files.json.");
  const staging = await mkdtemp(path.join(directory, ".source-restore-"));
  try {
    execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", staging]);
    for (const file of files) {
      const content = await regularFile(staging, file.path);
      if (digest(content) !== file.sha256 || !!((await lstat(path.join(staging, file.path))).mode & 0o111) !== file.executable) {
        throw new Error(`Restored ${file.path} differs from source-files.json.`);
      }
    }
    await rm(path.join(directory, "source"), { recursive: true, force: true });
    await rename(staging, path.join(directory, "source"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [operation, directory] = process.argv.slice(2);
  if (operation !== "restore") {
    console.error("Usage: source.mts restore [release-directory]");
    process.exit(2);
  }
  const files = await restoreSource(path.resolve(directory ?? process.env.RELEASE_OUTPUT ?? ".cache/release"));
  console.log(`Restored the release source snapshot: ${files.length} files verified against source-files.json.`);
}
