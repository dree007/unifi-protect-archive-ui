import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";
// Existing locked ESLint dependency; no additional package or scanner.
const YAML = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => unknown };

import { validateNativeBundle } from "../../scripts/release/native-compliance.mts";

import { digest, exportSource } from "../../scripts/release/source.mts";
import { PLATFORM, publicUrl, publishingGate, REPOSITORY, REQUIRED_RELEASE_CHECKS, releaseVersion, requireAbsentTag, verifyPublicTree, verifyImage, type ReleaseManifest, type Validation } from "../../scripts/release/metadata.mts";

describe("reviewed release source", () => {
  it("exports public content without private configuration/history and binds changes to a content digest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "unifi-release-source-"));
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, ".git"));
      await writeFile(path.join(root, "src/example.ts"), 'export const camera = "Garden";');
      await writeFile(path.join(root, "README.md"), "Synthetic project\n");
      await writeFile(path.join(root, ".env.local"), "EXAMPLE_ONLY=not-a-real-secret\n");
      const names = ["src/example.ts", "README.md", ".env.local", ".git/config", "AGENTS.md", "docs/release/internal.md"];
      const first = await exportSource(root, path.join(root, ".cache/release"), names);
      expect(first.files.map((file) => file.path)).toEqual(["README.md", "src/example.ts"]);
      expect(first.files[0].gitBlobSha1).toBe(execFileSync("git", ["hash-object", "--stdin"], { input: "Synthetic project\n", encoding: "utf8" }).trim());
      expect(await readFile(path.join(first.snapshot, "src/example.ts"), "utf8")).toContain("Garden");
      await expect(readFile(path.join(first.snapshot, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await exportSource(root, path.join(root, ".cache/release"), names)).sha256).toBe(first.sha256);
      await writeFile(path.join(root, "src/example.ts"), 'export const camera = "Driveway";');
      expect((await exportSource(root, path.join(root, ".cache/release"), names)).sha256).not.toBe(first.sha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects symlinks into private files rather than following them into the build context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "unifi-release-symlink-"));
    try {
      await writeFile(path.join(root, ".env.local"), "SYNTHETIC_ONLY=example\n");
      await symlink(".env.local", path.join(root, "README.md"));
      await expect(exportSource(root, path.join(root, ".cache/release"), ["README.md"])).rejects.toThrow("regular files");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("release publishing gates", () => {
  const manifest: ReleaseManifest = {
    schema: 1, version: "1.0.0", platform: PLATFORM, created: "2026-10-12T00:00:00.000Z",
    source: { sha256: "a".repeat(64), archiveSha256: "b".repeat(64), repository: REPOSITORY, revision: "c".repeat(40), downloadUrl: `${REPOSITORY}/releases/download/v1.0.0/source.tar.gz` },
    image: { name: "example:1.0.0", id: `sha256:${"d".repeat(64)}`, size: 1, archiveSha256: "e".repeat(64) },
    native: { node: "synthetic", packages: [], bundled: ["npm", "sharp", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"].map((name) => ({ name, version: "synthetic", license: "synthetic", files: [{ path: "synthetic", sha256: "a".repeat(64) }] })), bundleSha256: "f".repeat(64) },
  };
  const validation: Validation = { imageId: manifest.image.id, checks: [...REQUIRED_RELEASE_CHECKS.map((name) => ({ name, ok: true })), ...Array.from({ length: 44 }, (_, i) => ({ name: `synthetic check ${i}`, ok: true }))], security: [{ name: "engine", status: "PASS" }, { name: "boundary", status: "PASS" }] };
  const native = { schema: 2 as const, imageId: manifest.image.id, version: manifest.version, applicationSourceSha256: manifest.source.sha256, manifestSha256: "a".repeat(64), runtimeSha256: "b".repeat(64), technical: "PASS" as const, compliance: "PASS" as const, issues: [], files: 1, bytes: 1, archiveSha256: manifest.native.bundleSha256 };
  const env = { CI_COMMIT_TAG: "v1.0.0", CI_COMMIT_REF_PROTECTED: "true", CI_JOB_MANUAL: "true", GHCR_APPROVED_IMAGE_ID: manifest.image.id, NATIVE_SOURCE_DOWNLOAD_URL: `${REPOSITORY}/releases/download/v1.0.0/native-source.tar.gz` };

  it("admits only an explicitly approved tested image with complete source declarations", () => {
    expect(() => publishingGate(manifest, validation, env, native)).not.toThrow();
  });
  it.each([
    { CI_COMMIT_TAG: "feature/example" }, { CI_COMMIT_TAG: "main" }, { CI_COMMIT_TAG: "v1.0.0-rc.1" },
    { CI_COMMIT_REF_PROTECTED: "false" }, { CI_JOB_MANUAL: "false" }, { GHCR_APPROVED_IMAGE_ID: "another-image" },
  ])("rejects unapproved trigger/context %j", (overrides) => {
    expect(() => publishingGate(manifest, validation, { ...env, ...overrides }, native)).toThrow();
  });
  it("blocks missing native source, missing public revision and untested/failed images", () => {
    expect(() => publishingGate({ ...manifest, native: { ...manifest.native, bundleSha256: null } }, validation, env, native)).toThrow("Native");
    expect(() => publishingGate({ ...manifest, native: { ...manifest.native, bundled: undefined } }, validation, env, native)).toThrow("Bundled");
    expect(() => publishingGate({ ...manifest, source: { ...manifest.source, revision: "" } }, validation, env, native)).toThrow("source revision");
    expect(() => publishingGate(manifest, { ...validation, imageId: "changed" }, env, native)).toThrow("exact image");
    expect(() => publishingGate(manifest, { ...validation, security: [{ name: "engine", status: "FAIL" }] }, env, native)).toThrow("exact image");
    expect(() => publishingGate(manifest, { ...validation, checks: [] }, env, native)).toThrow("exact image");
  });
  it("requires mandatory native evidence and blocks legal-review or mismatched source reports", () => {
    expect(() => publishingGate(manifest, validation, env)).toThrow("Native compliance");
    expect(() => publishingGate(manifest, validation, env, { ...native, compliance: "LEGAL REVIEW REQUIRED" })).toThrow("Native compliance");
    expect(() => publishingGate(manifest, validation, env, { ...native, imageId: "changed" })).toThrow("Native compliance");
    expect(() => publishingGate(manifest, validation, env, { ...native, archiveSha256: "changed" })).toThrow("Native compliance");
  });
  it("validates fixed versions and credential-free HTTPS source locations", () => {
    expect(releaseVersion("1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(() => releaseVersion("latest")).toThrow();
    expect(() => releaseVersion("1.0.0-rc.0")).toThrow();
    expect(publicUrl("https://source.example.invalid/source.tar.gz")).toContain("https:");
    for (const url of ["http://example.invalid", "https://user:example@example.invalid", "https://example.invalid?token=synthetic"]) expect(() => publicUrl(url)).toThrow();
  });
  it("never interprets an existing tag or registry/auth error as permission to overwrite", () => {
    expect(() => requireAbsentTag(404)).not.toThrow();
    for (const status of [200, 301, 401, 403, 429, 500]) expect(() => requireAbsentTag(status)).toThrow();
  });
  it("inspects the loaded image identity, non-root runtime, labels and source offer before publishing", () => {
    const image = { Id: manifest.image.id, Os: "linux", Architecture: "amd64", Config: { User: "node", Cmd: ["node", "server.js"], Env: [`IMAGE_SOURCE_URL=${manifest.source.downloadUrl}`], Labels: {
      "org.opencontainers.image.version": manifest.version, "org.opencontainers.image.licenses": "AGPL-3.0-only",
      "org.opencontainers.image.source": REPOSITORY, "org.opencontainers.image.revision": manifest.source.revision,
      "io.unifi-protect-archive-ui.source-sha256": manifest.source.sha256,
    } } };
    expect(() => verifyImage(manifest, image)).not.toThrow();
    for (const config of [
      { ...image.Config, User: "root" }, { ...image.Config, Env: [...image.Config.Env, "GHCR_TOKEN=synthetic"] },
      { ...image.Config, Labels: { ...image.Config.Labels, "io.unifi-protect-archive-ui.source-sha256": "changed" } },
    ]) expect(() => verifyImage(manifest, { ...image, Config: config })).toThrow();
  });
});

it("requires the public Git tree to match every approved build file, byte identity and execute bit", () => {
  const file = { path: "README.md", sha256: "a".repeat(64), gitBlobSha1: "b".repeat(40), executable: false };
  const entry = { path: file.path, sha: file.gitBlobSha1, mode: "100644", type: "blob" };
  expect(() => verifyPublicTree([file], { truncated: false, tree: [entry] })).not.toThrow();
  for (const tree of [
    { truncated: true, tree: [entry] },
    { truncated: false, tree: [{ ...entry, sha: "c".repeat(40) }] },
    { truncated: false, tree: [{ ...entry, mode: "120000" }] },
    { truncated: false, tree: [entry, { ...entry, path: ".env.local" }] },
  ]) expect(() => verifyPublicTree([file], tree)).toThrow();
});

it("an approved file/hash list alone cannot bypass full corresponding-source validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unifi-native-review-"));
  try {
    await writeFile(path.join(root, "source.txt"), "Synthetic text, not a source package.\n");
    await writeFile(path.join(root, "review.json"), JSON.stringify({ approved: true, files: [{ path: "source.txt", sha256: digest("Synthetic text, not a source package.\n") }] }));
    await expect(validateNativeBundle(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("production Compose uses prebuilt images and CI publishes only manually on protected version refs", async () => {
  const compose = YAML.load(await readFile("compose.yaml", "utf8")) as { services: Record<string, Record<string, unknown>> };
  expect(Object.keys(compose.services)).toEqual(["postgres", "migrate", "web", "worker"]);
  for (const service of Object.values(compose.services) as Record<string, unknown>[]) {
    for (const key of ["build", "stop_grace_period", "init", "logging"]) expect(service).not.toHaveProperty(key);
  }
  expect(compose.services.web.image).toBe(compose.services.worker.image);
  expect(compose.services.web.image).toBe(compose.services.migrate.image);
  const ci = YAML.load(await readFile(".gitlab-ci.yml", "utf8")) as Record<string, { resource_group: string; rules: { when?: string; allow_failure?: boolean; if?: string }[]; needs: string[]; variables: Record<string, string> }>;
  expect(ci["ghcr-publish"].resource_group).toBe("ghcr-release");
  expect(ci["ghcr-publish"].rules[0]).toMatchObject({ when: "manual", allow_failure: false });
  expect(ci["ghcr-publish"].rules[0].if).toContain('CI_COMMIT_REF_PROTECTED == "true"');
  expect(ci["ghcr-publish"].rules[0].if).toContain("CI_COMMIT_TAG");
  expect(ci["ghcr-publish"].rules.at(-1)).toEqual({ when: "never" });
  expect(ci["release-build"].needs).toContain("docker-integration");
  const nativeJob = ci["native-compliance"] as unknown as { allow_failure: boolean; rules: { if?: string; when?: string }[]; needs: { job: string; artifacts: boolean; optional?: boolean }[] };
  expect(nativeJob.allow_failure).toBe(false);
  expect(nativeJob.rules[0].if).toBe(ci["release-build"].rules[0].if);
  expect(nativeJob.needs).toEqual([{ job: "release-build", artifacts: true }]);
  expect(ci["ghcr-publish"].needs).toContainEqual({ job: "native-compliance", artifacts: true });
  expect(ci["release-build"].variables).not.toHaveProperty("GHCR_TOKEN");
});

it("runs release jobs only for protected version tags, never for branches or web pipelines", async () => {
  const source = await readFile(".gitlab-ci.yml", "utf8");
  const ci = YAML.load(source) as Record<string, { rules: { if?: string; when?: string }[] }>;
  const tagRule = '$CI_COMMIT_TAG =~ /^v1\\.0\\.0(-rc\\.[1-9][0-9]*)?$/ && $CI_COMMIT_REF_PROTECTED == "true"';
  for (const name of ["release-build", "native-compliance"]) expect(ci[name].rules).toEqual([{ if: tagRule }, { when: "never" }]);
  expect(ci["ghcr-publish"].rules).toHaveLength(2);
  expect(ci["ghcr-publish"].rules[0].if).toBe(tagRule);
  // No branch-specific or opt-in path into the release stages remains.
  expect(source).not.toMatch(/RUN_NATIVE_COMPLIANCE|CI_PIPELINE_SOURCE == "web"|feature\//);
});
