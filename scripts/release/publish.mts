import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { digest, type SourceFile } from "./source.mts";
import { fileDigest, publishingGate, releaseImageTag, requireAbsentTag, verifyPublicTree, verifyImage, type ReleaseManifest, type Validation } from "./metadata.mts";
import { inspectRuntimeLayers } from "./layers.mts";
import { extractNativeArchive, inspectRuntime, runtimeIdentity, validateNativeBundle, run, type NativeValidation } from "./native-compliance.mts";

const output = path.resolve(process.env.RELEASE_OUTPUT ?? ".cache/release");
const manifest: ReleaseManifest = JSON.parse(await readFile(path.join(output, "release.json"), "utf8"));
const validation: Validation = JSON.parse(await readFile(path.join(output, "validation.json"), "utf8"));
const native: NativeValidation & { archiveSha256: string } = JSON.parse(await readFile(path.join(output, "native-compliance.json"), "utf8"));
manifest.native.bundleSha256 = native.archiveSha256;
publishingGate(manifest, validation, process.env, native);
const sourceFiles: { sha256: string; files: SourceFile[] } = JSON.parse(await readFile(path.join(output, "source-files.json"), "utf8"));
if (digest(JSON.stringify(sourceFiles.files)) !== manifest.source.sha256 || sourceFiles.sha256 !== manifest.source.sha256) throw new Error("Source-file manifest changed after the image build.");
if (await fileDigest(path.join(output, "image.tar.gz")) !== manifest.image.archiveSha256 || await fileDigest(path.join(output, "source.tar.gz")) !== manifest.source.archiveSha256 || await fileDigest(path.join(output, "native-source.tar.gz")) !== manifest.native.bundleSha256) throw new Error("Release artifacts changed after validation.");
// Revalidate the source material rather than trusting an artifact that merely says PASS.
const prepared = await mkdtemp(path.join(tmpdir(), "unifi-publish-native-"));
try {
  await extractNativeArchive(path.join(output, "native-source.tar.gz"), prepared);
  await run("docker", ["load", "-i", path.join(output, "image.tar.gz")]);
  verifyImage(manifest, JSON.parse(execFileSync("docker", ["image", "inspect", manifest.image.id], { encoding: "utf8" }))[0]);
  await inspectRuntimeLayers(manifest.image.id);
  const fresh = await validateNativeBundle(prepared, { imageId: manifest.image.id, version: manifest.version, applicationSourceSha256: manifest.source.sha256, runtimeSha256: runtimeIdentity(inspectRuntime(manifest.image.id)) });
  if (fresh.compliance !== "PASS" || fresh.manifestSha256 !== native.manifestSha256) throw new Error("Native gate evidence differs from the tested source bundle.");
} finally { await rm(prepared, { recursive: true, force: true }); }

async function github(endpoint: string) {
  const response = await fetch(`https://api.github.com/repos/dree007/unifi-protect-archive-ui/${endpoint}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "unifi-protect-archive-ui-release" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Public source revision cannot be verified (${response.status}).`);
  return response.json();
}
const commit = await github(`commits/v${manifest.version}`) as { sha: string; commit: { tree: { sha: string } } };
if (commit.sha !== manifest.source.revision) throw new Error("Public version tag does not identify the approved source revision.");
verifyPublicTree(sourceFiles.files, await github(`git/trees/${commit.commit.tree.sha}?recursive=1`));

async function checkPublicSource(url: string, expected: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Corresponding source is not publicly downloadable (${response.status}).`);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally { reader.releaseLock(); }
  if (hash.digest("hex") !== expected) throw new Error("Public corresponding source differs from the reviewed artifact.");
}
await checkPublicSource(manifest.source.downloadUrl, manifest.source.archiveSha256);
await checkPublicSource(process.env.NATIVE_SOURCE_DOWNLOAD_URL!, manifest.native.bundleSha256!);

const username = process.env.GHCR_USERNAME;
const token = process.env.GHCR_TOKEN;
if (username !== "dree007" || !token) throw new Error("Protected GHCR publishing credentials are missing or belong to an unapproved account.");
// Fail closed unless the registry explicitly proves that this immutable tag is absent.
const credentials = Buffer.from(`${username}:${token}`).toString("base64");
const profile = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
if (!profile.ok || (await profile.json() as { login: string }).login.toLowerCase() !== "dree007") throw new Error("Publishing token identity could not be verified as the approved owner.");
let packageExists = false;
for (let page = 1; ; page++) {
  if (page > 100) throw new Error("Owned package list was not complete; publishing blocked.");
  const response = await fetch(`https://api.github.com/users/dree007/packages?package_type=container&per_page=100&page=${page}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Owned package inventory could not be verified (${response.status}).`);
  const packages = await response.json() as { name: string }[];
  if (packages.some((item) => item.name === "unifi-protect-archive-ui")) { packageExists = true; break; }
  if (packages.length < 100) break;
}
async function registryBearer() {
  const auth = await fetch("https://ghcr.io/token?service=ghcr.io&scope=repository:dree007/unifi-protect-archive-ui:pull", {
    headers: { Authorization: `Basic ${credentials}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!auth.ok) throw new Error(`Registry tag check could not authenticate (${auth.status}).`);
  const { token: bearer } = await auth.json() as { token: string };
  if (!bearer) throw new Error("Registry authentication returned no access token.");
  return bearer;
}
const tag = releaseImageTag(manifest.version);
// An authenticated owner inventory proves first-package absence even when the
// registry hides unknown repositories behind authorization errors. Existing
// packages still require an explicit manifest 404; other errors fail closed.
if (packageExists) {
  const existing = await fetch(`https://ghcr.io/v2/dree007/unifi-protect-archive-ui/manifests/${manifest.version}`, {
    method: "HEAD", headers: { Authorization: `Bearer ${await registryBearer()}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  requireAbsentTag(existing.status);
}

const config = await mkdtemp(path.join(tmpdir(), "unifi-ghcr-auth-"));
await mkdir(config, { recursive: true });
async function docker(args: string[], input?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { env: { ...process.env, DOCKER_CONFIG: config }, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin!.end(input);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Registry operation failed (${code}).`)));
  });
}
try {
  await docker(["load", "-i", path.join(output, "image.tar.gz")]);
  verifyImage(manifest, JSON.parse(execFileSync("docker", ["image", "inspect", manifest.image.id], { encoding: "utf8", env: { ...process.env, DOCKER_CONFIG: config } }))[0]);
  // Load the tested artifact; never rebuild in the job holding registry credentials.
  await docker(["tag", manifest.image.id, tag]);
  await docker(["login", "ghcr.io", "--username", username, "--password-stdin"], token);
  await docker(["push", tag]);
  const published = await fetch(`https://ghcr.io/v2/dree007/unifi-protect-archive-ui/manifests/${manifest.version}`, {
    method: "HEAD", headers: { Authorization: `Bearer ${await registryBearer()}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const registryDigest = published.headers.get("docker-content-digest");
  if (!published.ok || !registryDigest || !/^sha256:[a-f0-9]{64}$/.test(registryDigest)) throw new Error("Image was pushed but its distribution digest could not be verified; do not retry or overwrite the tag blindly.");
  await writeFile(path.join(output, "published.json"), JSON.stringify({ tag, registryDigest, imageId: manifest.image.id, sourceSha256: manifest.source.sha256, publicRevision: manifest.source.revision, platform: manifest.platform }, null, 2) + "\n");
  await writeFile(path.join(output, "published-tag.txt"), tag + "\n");
} finally {
  await rm(config, { recursive: true, force: true });
}
