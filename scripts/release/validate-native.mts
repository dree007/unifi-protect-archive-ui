import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectRuntime, runtimeIdentity, validateNativeBundle } from "./native-compliance.mts";
import type { ReleaseManifest } from "./metadata.mts";

const root = path.resolve(process.env.NATIVE_BUNDLE_DIRECTORY ?? ".cache/release-sources");
const release: ReleaseManifest | undefined = process.env.RELEASE_OUTPUT
  ? JSON.parse(await readFile(path.join(process.env.RELEASE_OUTPUT, "release.json"), "utf8"))
  : undefined;
const result = await validateNativeBundle(root, release ? { imageId: release.image.id, version: release.version, applicationSourceSha256: release.source.sha256, runtimeSha256: runtimeIdentity(inspectRuntime(release.image.id)) } : undefined);
if (process.env.NATIVE_VALIDATION_OUTPUT) await writeFile(process.env.NATIVE_VALIDATION_OUTPUT, JSON.stringify(result, null, 2) + "\n");
console.log(`Native sources: ${result.files} files, technical ${result.technical}, compliance ${result.compliance}.`);
for (const issue of result.issues) console.error(issue);
if (result.compliance !== "PASS") process.exitCode = 1;
