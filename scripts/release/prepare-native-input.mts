import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dscFiles, sourceRequests } from "./collect-native-sources.mts";
import { fileDigest, type ReleaseManifest } from "./metadata.mts";
import { regularFile } from "./source.mts";
import { run } from "./native-compliance.mts";

const release: ReleaseManifest = JSON.parse(await readFile(process.env.RELEASE_MANIFEST ?? ".cache/release/release.json", "utf8"));
const input = path.resolve(process.env.NATIVE_SOURCE_DIRECTORY ?? ".cache/native-acquisition");
const output = path.resolve(process.env.NATIVE_INPUT_DIRECTORY ?? ".cache/native-input/source");
if (output === input || output.startsWith(input + path.sep)) throw new Error("Controlled input must be separate from the retained acquisition cache.");
const keyrings = (process.env.NATIVE_SOURCE_KEYRINGS ?? "/usr/share/keyrings/debian-keyring.gpg,/usr/share/keyrings/debian-maintainers.gpg").split(",");
const extraction = [], signatures = [];
for (const request of sourceRequests(release)) {
  const directory = `debian/${request.source}_${encodeURIComponent(request.version)}`;
  const names = (await readdir(path.join(input, directory))).filter((name) => name.endsWith(".dsc"));
  if (names.length !== 1) throw new Error(`Missing source descriptor: ${request.source}`);
  const descriptor = `${directory}/${names[0]}`;
  const text = (await regularFile(input, descriptor)).toString();
  const files = dscFiles(text, request.source, request.version);
  await mkdir(path.join(output, directory), { recursive: true });
  for (const file of [...files, { path: names[0], sha256: await fileDigest(path.join(input, descriptor)), size: (await stat(path.join(input, descriptor))).size }]) {
    const name = `${directory}/${file.path}`;
    await regularFile(input, name);
    if (await fileDigest(path.join(input, name)) !== file.sha256) throw new Error(`Acquired source checksum mismatch: ${name}`);
    await copyFile(path.join(input, name), path.join(output, name));
  }
  // Exact versions and all SHA-256 entries are verified before any extraction.
  const temporary = await mkdtemp(path.join(tmpdir(), "unifi-native-input-"));
  try {
    const source = path.join(temporary, "source");
    await run("dpkg-source", ["--no-check", "-x", path.join(output, descriptor), source]);
    for (const name of ["rules", "changelog", "copyright", "copyright.in", "copyright.debian", "control"]) {
      const original = path.join(source, "debian", name);
      try {
        if ((await stat(original)).isFile()) {
          const target = path.join(output, "extracted", path.posix.basename(directory), "debian", name);
          await mkdir(path.dirname(target), { recursive: true }); await copyFile(original, target);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    extraction.push({ descriptor, extractExit: 0, buildRules: (await stat(path.join(source, "debian/rules"))).isFile(), changelog: (await stat(path.join(source, "debian/changelog"))).isFile() });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  execFileSync("gpgv", [...keyrings.flatMap((keyring) => ["--keyring", keyring]), path.join(output, descriptor)], { stdio: "ignore" });
  signatures.push({ descriptor, signatureExit: 0, verified: true });
  console.log(`${request.source}=${request.version}: source, build material and signature verified`);
}
for (const name of ["node-v24.21.0.tar.xz", ...(release.native.bundled?.some((item) => item.name === "npm") ? ["npm-preferred.tar.gz"] : [])]) {
  await regularFile(input, `upstream/${name}`); await mkdir(path.join(output, "upstream"), { recursive: true });
  await copyFile(path.join(input, "upstream", name), path.join(output, "upstream", name));
}
const checksums = process.env.NODE_SOURCE_CHECKSUMS ?? path.join(input, "node-checksums.txt");
await copyFile(checksums, path.join(output, "node-checksums.txt"));
await writeFile(path.join(output, "source-extraction.json"), JSON.stringify(extraction, null, 2) + "\n");
await writeFile(path.join(output, "dsc-signatures.json"), JSON.stringify(signatures, null, 2) + "\n");
console.log("Controlled input prepared; package sources can now be archived and pinned for release CI.");
