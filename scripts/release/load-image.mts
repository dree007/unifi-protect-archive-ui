// Loads the release image that release-build produced – and only that image: the archive must match
// the SHA-256 in release.json, and after `docker load` the image ID and source digest must match the
// ledger. No rebuild, no recomputed identity (transfer: scripts/release/transfer.mts).
//
//   node scripts/release/load-image.mts [release-directory]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { fileDigest, type ReleaseManifest } from "./metadata.mts";
import { run } from "./native-compliance.mts";

interface ImageInspect {
  Id: string;
  Config: { Labels: Record<string, string> | null };
}

/** Throws unless the inspected image is exactly the one recorded in the release ledger. */
export function verifyLoadedImage(manifest: ReleaseManifest, image: ImageInspect | undefined) {
  if (!image || image.Id !== manifest.image.id) throw new Error("The loaded image is not the image release-build recorded.");
  if (image.Config.Labels?.["io.unifi-protect-archive-ui.source-sha256"] !== manifest.source.sha256) {
    throw new Error("The loaded image carries a different application source identity.");
  }
}

export async function loadReleaseImage(directory: string) {
  const manifest: ReleaseManifest = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8"));
  const archive = path.join(directory, "image.tar.gz");
  if ((await fileDigest(archive)) !== manifest.image.archiveSha256) throw new Error("image.tar.gz differs from release.json.");
  await run("docker", ["load", "-i", archive]);
  const [image] = JSON.parse(execFileSync("docker", ["image", "inspect", manifest.image.id], { encoding: "utf8" })) as ImageInspect[];
  verifyLoadedImage(manifest, image);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const manifest = await loadReleaseImage(path.resolve(process.argv[2] ?? process.env.RELEASE_OUTPUT ?? ".cache/release"));
  console.log(`Loaded the exact release image ${manifest.image.id} (archive sha256 ${manifest.image.archiveSha256}).`);
}
