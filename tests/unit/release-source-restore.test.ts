import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileDigest } from "../../scripts/release/metadata.mts";
import { APPLICATION_BUILD_FILES } from "../../scripts/release/native-bundle.mts";
import { exportSource, restoreSource, verifiedSourceFile } from "../../scripts/release/source.mts";

// native-compliance runs in a fresh job: it only has the release-build artifacts, never the source
// snapshot directory release-build exported (GitLab pipeline #201, job #803: ENOENT on .cache/release/source).

let root: string, release: string, sourceSha256: string;

async function writeArchive(directory: string, archive = path.join(release, "source.tar.gz")) {
  execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", directory, "."]);
  await writeFile(path.join(release, "release.json"), JSON.stringify({ source: { sha256: sourceSha256, archiveSha256: await fileDigest(archive) } }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "unifi-release-restore-"));
  release = path.join(root, ".cache/release");
  await writeFile(path.join(root, "Dockerfile"), "FROM debian:bookworm-slim AS runtime\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await writeFile(path.join(root, "LICENSE"), "Synthetic license\n");
  await writeFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "# Synthetic notices\n");
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/start.sh"), "#!/bin/sh\n");
  await chmod(path.join(root, "scripts/start.sh"), 0o755);
  const exported = await exportSource(root, release, [...APPLICATION_BUILD_FILES, "scripts/start.sh"]);
  sourceSha256 = exported.sha256;
  await writeArchive(exported.snapshot);
  // Like the CI job: the snapshot directory is not a job artifact.
  await rm(exported.snapshot, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A copy of the snapshot to build manipulated archives from. */
async function snapshotCopy() {
  const copy = await mkdtemp(path.join(tmpdir(), "unifi-release-restore-copy-"));
  execFileSync("tar", ["-xzf", path.join(release, "source.tar.gz"), "-C", copy]);
  return copy;
}

describe("application source in the native-compliance job", () => {
  it("names the missing snapshot and how to restore it instead of a bare ENOENT", async () => {
    await expect(verifiedSourceFile(release, sourceSha256, "Dockerfile")).rejects.toThrow(/lacks Dockerfile.*not a job artifact.*source\.mts restore/);
  });

  it("restores exactly the verified source from the release-build artifact", async () => {
    const files = await restoreSource(release);
    expect(files.map((file) => file.path).sort()).toEqual([...APPLICATION_BUILD_FILES, "scripts/start.sh"].sort());
    for (const name of APPLICATION_BUILD_FILES) {
      expect(await readFile(await verifiedSourceFile(release, sourceSha256, name), "utf8")).toBe(await readFile(path.join(root, name), "utf8"));
    }
    expect(execFileSync("find", [".", "-type", "f"], { cwd: path.join(release, "source"), encoding: "utf8" }).trim().split("\n").map((name) => name.slice(2)).sort()).toEqual([...APPLICATION_BUILD_FILES, "scripts/start.sh"].sort());
    // Idempotent for a retried step; no staging directory stays behind.
    await restoreSource(release);
    expect(execFileSync("ls", ["-A", release], { encoding: "utf8" }).split("\n")).not.toContainEqual(expect.stringMatching(/^\.source-restore-/));
  });

  it("fails clearly when source.tar.gz did not arrive", async () => {
    await rm(path.join(release, "source.tar.gz"));
    await expect(restoreSource(release)).rejects.toThrow(/source\.tar\.gz is missing.*release-build job artifacts/);
  });

  it("rejects an archive that release.json does not pin", async () => {
    await writeFile(path.join(release, "source.tar.gz"), "not the reviewed archive");
    await expect(restoreSource(release)).rejects.toThrow(/differs from release\.json/);
  });

  it("rejects a source list that is not the image's source identity", async () => {
    const listing = JSON.parse(await readFile(path.join(release, "source-files.json"), "utf8"));
    listing.files[0].sha256 = "0".repeat(64);
    await writeFile(path.join(release, "source-files.json"), JSON.stringify(listing));
    await expect(restoreSource(release)).rejects.toThrow(/does not match the release source identity/);
  });

  it("rejects archives with extra, missing, changed or linked files, even when release.json pins them", async () => {
    const copy = await snapshotCopy();
    try {
      await writeFile(path.join(copy, "extra.txt"), "unlisted\n");
      await writeArchive(copy);
      await expect(restoreSource(release)).rejects.toThrow(/unexpected entry: \.\/extra\.txt/);
      await rm(path.join(copy, "extra.txt"));

      await rm(path.join(copy, "LICENSE"));
      await writeArchive(copy);
      await expect(restoreSource(release)).rejects.toThrow(/lacks files listed/);

      await writeFile(path.join(copy, "LICENSE"), "Changed license\n");
      await writeArchive(copy);
      await expect(restoreSource(release)).rejects.toThrow(/Restored LICENSE differs/);

      await rm(path.join(copy, "LICENSE"));
      await symlink("Dockerfile", path.join(copy, "LICENSE"));
      await writeArchive(copy);
      await expect(restoreSource(release)).rejects.toThrow(/unexpected entry: \.\/LICENSE/);
    } finally { await rm(copy, { recursive: true, force: true }); }
    await expect(readFile(path.join(release, "source/Dockerfile"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a snapshot file that differs from source-files.json", async () => {
    await restoreSource(release);
    await writeFile(path.join(release, "source/THIRD_PARTY_NOTICES.md"), "# Other notices\n");
    await expect(verifiedSourceFile(release, sourceSha256, "THIRD_PARTY_NOTICES.md")).rejects.toThrow(/differs from source-files\.json/);
  });
});

describe("CI wiring", () => {
  it("ships the pinned source archive and restores it before the native bundle is assembled", async () => {
    const ci = await readFile(".gitlab-ci.yml", "utf8");
    for (const file of ["release.json", "source-files.json", "source.tar.gz"]) expect(ci).toContain(`- .cache/release/${file}\n`);
    const script = await readFile("scripts/release/ci.sh", "utf8");
    const load = script.indexOf("node scripts/release/load-image.mts .cache/release");
    const restore = script.indexOf("node scripts/release/source.mts restore .cache/release");
    const bundle = script.indexOf("node scripts/release/native-bundle.mts");
    expect(load).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(load);
    expect(bundle).toBeGreaterThan(restore);
  });
});
