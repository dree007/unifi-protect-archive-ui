import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { type SourceFile } from "./source.mts";
import type { NativeValidation } from "./native-compliance.mts";

export const REPOSITORY = "https://github.com/dree007/unifi-protect-archive-ui";
export const REGISTRY_IMAGE = "ghcr.io/dree007/unifi-protect-archive-ui";
export const PLATFORM = "linux/amd64";
export const REQUIRED_RELEASE_CHECKS = [
  "installation without source: only compose.yaml and .env, prebuilt image, automatic migrations",
  "host-default logging: all roles retain diagnostic stdout/stderr without Compose logging blocks",
  "web stops an active thumbnail request and real ffmpeg child within the default deadline",
  "worker stopped during blocked archiveScan: bounded exit, locks released, idempotent recovery",
  "worker stopped during blocked reconciliation: bounded exit, locks released, idempotent recovery",
];

export interface NativePackage {
  name: string; version: string; source: string; sourceVersion: string; copyrightSha256: string;
}
export interface BundledNative {
  name: string; version: string; license: string; files: { path: string; sha256: string }[];
}
export interface ReleaseManifest {
  schema: 1; version: string; platform: string; created: string;
  source: { sha256: string; archiveSha256: string; repository: string; revision: string; downloadUrl: string };
  image: { name: string; id: string; size: number; archiveSha256: string };
  native: { node: string; packages: NativePackage[]; bundled?: BundledNative[]; bundleSha256: string | null };
}
export interface Validation {
  imageId: string;
  checks: { name: string; ok: boolean }[];
  security: { name: string; status: string }[];
}

export async function fileDigest(file: string) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}

export function releaseVersion(value: string) {
  if (!/^1\.0\.0(?:-rc\.[1-9]\d*)?$/.test(value)) throw new Error("Only 1.0.0 or a numbered 1.0.0 release candidate is prepared.");
  return value;
}

/** Registry tag of a release: the exact validated version, so a candidate is never tagged as 1.0.0. */
export function releaseImageTag(version: string) {
  return `${REGISTRY_IMAGE}:${releaseVersion(version)}`;
}

export function publicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Public source locations must be credential-free HTTPS URLs.");
  return url.href;
}

export function requireAbsentTag(status: number) {
  if (status !== 404) throw new Error(status >= 200 && status < 300 ? "Version tag already exists; overwriting is forbidden." : `Registry did not prove tag absence (${status}); publishing blocked.`);
}

export function releaseDownload(value: string, version: string, file: "source.tar.gz" | "native-source.tar.gz") {
  const expected = `${REPOSITORY}/releases/download/v${releaseVersion(version)}/${file}`;
  if (publicUrl(value) !== expected) throw new Error("Source bundles must use the approved public GitHub release asset location.");
  return expected;
}

export function verifyPublicTree(files: SourceFile[], tree: { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] }) {
  const blobs = tree.tree.filter((entry) => entry.type !== "tree");
  if (tree.truncated || blobs.length !== files.length) throw new Error("Public source tree is incomplete or contains unapproved files.");
  for (const file of files) {
    const entry = blobs.find((item) => item.path === file.path);
    if (!entry || entry.type !== "blob" || entry.sha !== file.gitBlobSha1 || entry.mode !== (file.executable ? "100755" : "100644")) throw new Error(`Public source differs from the image build context: ${file.path}`);
  }
}

export function verifyImage(manifest: ReleaseManifest, image: { Id: string; Os: string; Architecture: string; Config: { User: string; Cmd: string[]; Labels: Record<string, string>; Env: string[] } }) {
  const labels = image.Config.Labels;
  if (image.Id !== manifest.image.id || `${image.Os}/${image.Architecture}` !== PLATFORM || image.Config.User !== "node" || JSON.stringify(image.Config.Cmd) !== '["node","server.js"]' ||
      labels["org.opencontainers.image.version"] !== manifest.version || labels["org.opencontainers.image.licenses"] !== "AGPL-3.0-only" ||
      labels["org.opencontainers.image.source"] !== REPOSITORY || labels["org.opencontainers.image.revision"] !== manifest.source.revision ||
      labels["io.unifi-protect-archive-ui.source-sha256"] !== manifest.source.sha256 ||
      !image.Config.Env.includes(`IMAGE_SOURCE_URL=${manifest.source.downloadUrl}`) || image.Config.Env.some((entry) => /^(?:PGPASSWORD|UNIFI_PROTECT_API_KEY|GHCR_TOKEN)=./.test(entry))) {
    throw new Error("Image/runtime/source metadata does not match the approved artifact.");
  }
}

export function publishingGate(manifest: ReleaseManifest, validation: Validation, env: Record<string, string | undefined>, native?: NativeValidation & { archiveSha256: string | null }) {
  releaseVersion(manifest.version);
  if (env.CI_COMMIT_REF_PROTECTED !== "true" || env.CI_JOB_MANUAL !== "true" || env.CI_COMMIT_TAG !== `v${manifest.version}`) throw new Error("Publishing requires a manual job on the matching protected version tag.");
  if (env.GHCR_APPROVED_IMAGE_ID !== manifest.image.id) throw new Error("Explicit approval must name the exact tested image ID.");
  if (manifest.platform !== PLATFORM || manifest.source.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(manifest.source.revision)) throw new Error("The supported platform and approved public source revision must be recorded.");
  if (!manifest.native.bundleSha256) throw new Error("Native corresponding-source review/bundle is missing; binary publication is blocked.");
  if (!native || native.schema !== 2 || native.technical !== "PASS" || native.compliance !== "PASS" || native.imageId !== manifest.image.id || native.version !== manifest.version || native.applicationSourceSha256 !== manifest.source.sha256 || native.archiveSha256 !== manifest.native.bundleSha256) throw new Error("Native compliance must pass for the exact source/image; legal-review issues block publishing.");
  if (!Array.isArray(manifest.native.bundled)) throw new Error("Bundled runtime inventory is missing; rebuild the candidate.");
  releaseDownload(manifest.source.downloadUrl, manifest.version, "source.tar.gz");
  releaseDownload(env.NATIVE_SOURCE_DOWNLOAD_URL ?? "", manifest.version, "native-source.tar.gz");
  if (validation.imageId !== manifest.image.id || validation.checks.length < 49 || REQUIRED_RELEASE_CHECKS.some((name) => !validation.checks.some((check) => check.name === name && check.ok)) || validation.checks.some((item) => !item.ok) || validation.security.length < 2 || validation.security.some((item) => item.status !== "PASS")) {
    throw new Error("The exact image must pass the complete functional and supported-Engine security suite.");
  }
}
