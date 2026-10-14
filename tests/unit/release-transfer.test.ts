import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyLoadedImage } from "../../scripts/release/load-image.mts";
import type { ReleaseManifest } from "../../scripts/release/metadata.mts";
import {
  downloadTransfer,
  ledgerSha256,
  recordPath,
  transferUrl,
  uploadTransfer,
  verifyTransferRecord,
  type TransferRecord,
} from "../../scripts/release/transfer.mts";

const YAML = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => unknown };

const env = {
  CI_SERVER_URL: "https://ci.example.invalid",
  CI_PROJECT_ID: "7",
  CI_JOB_ID: "4711",
  CI_JOB_TOKEN: "synthetic-job-token",
};
const sha = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const CONTENT = "synthetic image archive, not a real image";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "unifi-release-transfer-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const record = (overrides: Partial<TransferRecord> = {}): TransferRecord => ({
  schema: 1,
  file: "image.tar.gz",
  url: "https://ci.example.invalid/api/v4/projects/7/packages/generic/release-transfer/job-4711/image.tar.gz",
  sha256: sha(CONTENT),
  size: CONTENT.length,
  jobId: "4711",
  ...overrides,
});

/** A fake fetch that records requests and answers with the given responses in order. */
function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit & { headers?: Record<string, string> } }[] = [];
  const impl = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: init as RequestInit & { headers?: Record<string, string> } });
    // Drain a streamed body like a real server would.
    if (init.body && typeof (init.body as ReadableStream).getReader === "function") {
      const reader = (init.body as ReadableStream).getReader();
      while (!(await reader.read()).done);
    }
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

describe("release transfer location", () => {
  it("is this project's own release-transfer Generic Package, versioned by the producing job", () => {
    expect(transferUrl(env, "image.tar.gz").href).toBe(
      "https://ci.example.invalid/api/v4/projects/7/packages/generic/release-transfer/job-4711/image.tar.gz",
    );
    expect(transferUrl(env, "native-source.tar.gz", "99").pathname).toBe(
      "/api/v4/projects/7/packages/generic/release-transfer/job-99/native-source.tar.gz",
    );
  });

  it.each([
    { ...env, CI_SERVER_URL: "http://ci.example.invalid" },
    { ...env, CI_PROJECT_ID: "7/../8" },
    { ...env, CI_JOB_ID: "" },
  ])("refuses an unsafe or incomplete CI identity", (bad) => expect(() => transferUrl(bad, "image.tar.gz")).toThrow());

  it("only transfers the two large release archives", () =>
    expect(() => transferUrl(env, "release.json" as never)).toThrow(/Not a release transfer file/));
});

describe("transfer record against the release ledger", () => {
  it("accepts a record that matches the ledger and this project's package", () => {
    expect(verifyTransferRecord(record(), sha(CONTENT), env).href).toBe(record().url);
  });

  it("never trusts the record's checksum over the ledger", () =>
    expect(() => verifyTransferRecord(record(), "b".repeat(64), env)).toThrow(/does not match the release ledger/));

  it("requires the ledger to pin a checksum", () => expect(() => verifyTransferRecord(record(), "", env)).toThrow());

  it.each([
    "https://other.example.invalid/api/v4/projects/7/packages/generic/release-transfer/job-4711/image.tar.gz",
    "https://ci.example.invalid/api/v4/projects/8/packages/generic/release-transfer/job-4711/image.tar.gz",
    "https://ci.example.invalid/api/v4/projects/7/packages/generic/native-source-input/job-4711/image.tar.gz",
    "https://ci.example.invalid/api/v4/projects/7/packages/generic/release-transfer/job-4711/image.tar.gz?token=x",
  ])("rejects a record pointing elsewhere: %s", (url) => expect(() => verifyTransferRecord(record({ url }), sha(CONTENT), env)).toThrow());
});

describe("upload", () => {
  it("streams the file with the job token, checks the stored checksum and returns a record", async () => {
    const file = path.join(dir, "image.tar.gz");
    await writeFile(file, CONTENT);
    const { impl, calls } = fakeFetch(Response.json({ file_name: "image.tar.gz", size: CONTENT.length, file_sha256: sha(CONTENT) }, { status: 201 }));

    const result = await uploadTransfer(file, env, impl);

    expect(result).toEqual(record());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${record().url}?select=package_file`);
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.headers).toMatchObject({ "JOB-TOKEN": "synthetic-job-token", "Content-Length": String(CONTENT.length) });
    expect(calls[0].init.redirect).toBe("error");
  });

  it("fails when GitLab stored different bytes", async () => {
    const file = path.join(dir, "image.tar.gz");
    await writeFile(file, CONTENT);
    const { impl } = fakeFetch(Response.json({ size: CONTENT.length, file_sha256: "c".repeat(64) }, { status: 201 }));
    await expect(uploadTransfer(file, env, impl)).rejects.toThrow(/stored different bytes/);
  });

  it("explains HTTP 413 instead of failing silently", async () => {
    const file = path.join(dir, "image.tar.gz");
    await writeFile(file, CONTENT);
    const { impl } = fakeFetch(new Response("too large", { status: 413 }));
    await expect(uploadTransfer(file, env, impl)).rejects.toThrow(/\(413\).*size limit/);
  });

  it("refuses files other than the two archives and runs without a job token", async () => {
    const other = path.join(dir, "release.json");
    await writeFile(other, "{}");
    await expect(uploadTransfer(other, env, fakeFetch().impl)).rejects.toThrow();
    const file = path.join(dir, "image.tar.gz");
    await writeFile(file, CONTENT);
    await expect(uploadTransfer(file, { ...env, CI_JOB_TOKEN: "" }, fakeFetch().impl)).rejects.toThrow(/CI_JOB_TOKEN/);
  });
});

describe("download", () => {
  it("verifies the downloaded bytes against the ledger", async () => {
    const target = path.join(dir, "image.tar.gz");
    const { impl, calls } = fakeFetch(new Response(CONTENT));
    await downloadTransfer(record(), sha(CONTENT), target, env, impl);
    expect(await readFile(target, "utf8")).toBe(CONTENT);
    expect(calls[0].init.headers).toEqual({ "JOB-TOKEN": "synthetic-job-token" });
  });

  it("deletes a file that differs from the ledger", async () => {
    const target = path.join(dir, "image.tar.gz");
    const { impl } = fakeFetch(new Response("tampered bytes"));
    await expect(downloadTransfer(record(), sha(CONTENT), target, env, impl)).rejects.toThrow(/differs from the release ledger/);
    await expect(stat(target)).rejects.toThrow();
  });

  it("follows an object-storage redirect over HTTPS without the job token", async () => {
    const target = path.join(dir, "image.tar.gz");
    const { impl, calls } = fakeFetch(
      new Response(null, { status: 302, headers: { location: "https://objects.example.invalid/blob?signature=x" } }),
      new Response(CONTENT),
    );
    await downloadTransfer(record(), sha(CONTENT), target, env, impl);
    expect(calls[1].url).toBe("https://objects.example.invalid/blob?signature=x");
    expect(calls[1].init.headers).toBeUndefined();
  });

  it("refuses a redirect to plain HTTP", async () => {
    const { impl } = fakeFetch(new Response(null, { status: 302, headers: { location: "http://objects.example.invalid/blob" } }));
    await expect(downloadTransfer(record(), sha(CONTENT), path.join(dir, "x"), env, impl)).rejects.toThrow(/HTTPS/);
  });
});

describe("ledgers and records", () => {
  it("takes the expected checksums from release.json and native-compliance.json, not from the record", async () => {
    await writeFile(path.join(dir, "release.json"), JSON.stringify({ image: { archiveSha256: "d".repeat(64) } }));
    await writeFile(path.join(dir, "native-compliance.json"), JSON.stringify({ archiveSha256: "e".repeat(64) }));
    expect(await ledgerSha256(dir, "image.tar.gz")).toBe("d".repeat(64));
    expect(await ledgerSha256(dir, "native-source.tar.gz")).toBe("e".repeat(64));
    expect(recordPath(dir, "image.tar.gz")).toBe(path.join(dir, "transfer-image.tar.gz.json"));
  });
});

describe("loaded image identity", () => {
  const manifest = { image: { id: "sha256:" + "1".repeat(64) }, source: { sha256: "2".repeat(64) } } as unknown as ReleaseManifest;
  const inspect = (id: string, source: string) => ({ Id: id, Config: { Labels: { "io.unifi-protect-archive-ui.source-sha256": source } } });

  it("accepts exactly the image recorded by release-build", () =>
    expect(() => verifyLoadedImage(manifest, inspect(manifest.image.id, manifest.source.sha256))).not.toThrow());
  it("rejects another image ID (e.g. a rebuild)", () =>
    expect(() => verifyLoadedImage(manifest, inspect("sha256:" + "3".repeat(64), manifest.source.sha256))).toThrow());
  it("rejects another source identity", () =>
    expect(() => verifyLoadedImage(manifest, inspect(manifest.image.id, "4".repeat(64)))).toThrow());
  it("rejects a missing image", () => expect(() => verifyLoadedImage(manifest, undefined)).toThrow());
});

describe("CI wiring", () => {
  type Job = { artifacts: { paths: string[] }; needs?: unknown };
  const load = async () => YAML.load(await readFile(".gitlab-ci.yml", "utf8")) as Record<string, Job>;

  it("keeps the large archives out of job artifacts and ships the ledgers and transfer records", async () => {
    const ci = await load();
    const build = ci["release-build"].artifacts.paths;
    const compliance = ci["native-compliance"].artifacts.paths;
    for (const paths of [build, compliance]) {
      expect(paths).not.toContain(".cache/release/image.tar.gz");
      expect(paths).not.toContain(".cache/release/native-source.tar.gz");
    }
    expect(build).toEqual(expect.arrayContaining([".cache/release/release.json", ".cache/release/validation.json", ".cache/release/transfer-image.tar.gz.json"]));
    expect(compliance).toEqual(expect.arrayContaining([".cache/release/native-compliance.json", ".cache/release/transfer-native-source.tar.gz.json"]));
  });

  it("downloads, verifies and loads the recorded image instead of rebuilding it", async () => {
    const script = await readFile("scripts/release/ci.sh", "utf8");
    expect(script).toContain("compliance) transfer download image.tar.gz");
    expect(script).toContain("node scripts/release/load-image.mts .cache/release");
    expect(script).not.toMatch(/docker load -i \.cache\/release\/image\.tar\.gz/);
    expect(script).toContain("build) transfer upload .cache/release/image.tar.gz");
    expect(script).toContain("compliance) transfer upload .cache/release/native-source.tar.gz");
    expect(script).toMatch(/publish\) transfer download image\.tar\.gz \.cache\/release && transfer download native-source\.tar\.gz/);
    // The compliance step must not build an image itself.
    const compliance = script.slice(script.indexOf('elif [ "$operation" = compliance ]'), script.indexOf("else\n"));
    expect(compliance).not.toMatch(/build\.mts|docker build/);
  });
});
