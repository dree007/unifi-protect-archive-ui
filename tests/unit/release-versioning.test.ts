import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REGISTRY_IMAGE, releaseImageTag, releaseVersion } from "../../scripts/release/metadata.mts";

describe("release candidate versioning", () => {
  it("tags a candidate with its own version and only 1.0.0 as the final image", () => {
    expect(releaseImageTag("1.0.0")).toBe(`${REGISTRY_IMAGE}:1.0.0`);
    expect(releaseImageTag("1.0.0-rc.1")).toBe(`${REGISTRY_IMAGE}:1.0.0-rc.1`);
    expect(releaseImageTag("1.0.0-rc.12")).toBe(`${REGISTRY_IMAGE}:1.0.0-rc.12`);
    expect(releaseImageTag("1.0.0-rc.1")).not.toBe(releaseImageTag("1.0.0"));
  });

  it.each(["", "latest", "v1.0.0", "1.0.0-rc.0", "1.0.0-rc.01", "1.0.1", "1.0.0-beta.1", "1.0.0-rc.1 "])("rejects %j as a release version", (value) => {
    expect(() => releaseVersion(value)).toThrow();
    expect(() => releaseImageTag(value)).toThrow();
  });

  it("derives every recorded registry tag from the validated release version", async () => {
    for (const file of ["scripts/release/native-bundle.mts", "scripts/release/publish.mts"]) {
      const script = await readFile(file, "utf8");
      expect(script).toContain("releaseImageTag(");
      expect(script).not.toMatch(/unifi-protect-archive-ui:1\.0\.0|unifi-protect-archive-ui:\$\{/);
    }
    expect(await readFile("scripts/release/native-bundle.mts", "utf8")).toContain("image: releaseImageTag(release.version)");
  });
});

describe("release job guard (scripts/release/ci.sh)", () => {
  // A stub docker that fails with a marker code: reaching it proves the guard let the job through,
  // without building or running anything.
  const DOCKER_REACHED = 97;
  let bin: string;
  beforeAll(async () => {
    bin = await mkdtemp(path.join(tmpdir(), "unifi-release-guard-"));
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\nexit ${DOCKER_REACHED}\n`);
    await chmod(path.join(bin, "docker"), 0o755);
  });
  afterAll(async () => { await rm(bin, { recursive: true, force: true }); });

  async function guard(operation: string, env: Record<string, string | undefined>) {
    try {
      await promisify(execFile)("sh", ["scripts/release/ci.sh", operation], {
        // Built from scratch: CI variables of the pipeline running this test must not leak in.
        env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}`, CI_JOB_ID: "1", ...env },
      });
      return { code: 0, stderr: "" };
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      return { code: failure.code, stderr: failure.stderr };
    }
  }

  it.each(["build", "compliance", "publish"])("lets %s through only for a protected version tag", async (operation) => {
    for (const tag of ["v1.0.0", "v1.0.0-rc.1", "v1.0.0-rc.10"]) {
      expect((await guard(operation, { CI_COMMIT_TAG: tag, CI_COMMIT_REF_PROTECTED: "true" })).code).toBe(DOCKER_REACHED);
    }
  });

  it.each([
    {},
    { CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_TAG: "v1.0.0" },
    { CI_COMMIT_TAG: "v1.0.0", CI_COMMIT_REF_PROTECTED: "false" },
    { CI_COMMIT_TAG: "v1.0.0-rc.0", CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_TAG: "v1.0.1", CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_TAG: "1.0.0", CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_TAG: "v1.0.0-rc.1x", CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_TAG: "v1.0.0\nv1.0.0", CI_COMMIT_REF_PROTECTED: "true" },
    { CI_COMMIT_BRANCH: "feature/v1-native-license-compliance", CI_COMMIT_REF_PROTECTED: "true", RUN_NATIVE_COMPLIANCE: "1" },
    { CI_COMMIT_BRANCH: "main", CI_COMMIT_REF_PROTECTED: "true" },
  ])("refuses every operation without a protected version tag: %j", async (env) => {
    for (const operation of ["build", "compliance", "publish"]) {
      const result = await guard(operation, env);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("protected v1.0.0 or v1.0.0-rc.N tag");
    }
  });
});
