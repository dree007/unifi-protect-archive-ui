import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { materialPath, runtimeIdentity, validateNativeBundle, writeChecksumManifest, type MaterialFile, type NativeManifest } from "../../scripts/release/native-compliance.mts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "native-compliance-test-"));
  const stage = path.join(root, "temporary");
  await mkdir(path.join(stage, "synthetic-1.0/debian"), { recursive: true });
  await writeFile(path.join(stage, "synthetic-1.0/debian/rules"), "#!/usr/bin/make -f\n");
  await writeFile(path.join(stage, "synthetic-1.0/debian/changelog"), "synthetic (1.0) unstable; urgency=low\n\n  * Synthetic test only.\n\n -- Test Fixture <test@example.invalid>  Mon, 12 Oct 2026 12:00:00 +0000\n");
  const files: MaterialFile[] = [];
  async function add(name: string, data: string | Buffer) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
    const file = { path: name, sha256: createHash("sha256").update(data).digest("hex"), size: Buffer.byteLength(data) }; files.push(file); return file;
  }
  execFileSync("tar", ["-czf", path.join(stage, "synthetic_1.0.tar.gz"), "-C", stage, "synthetic-1.0"]);
  const archive = await add("debian/synthetic/synthetic_1.0.tar.gz", await readFile(path.join(stage, "synthetic_1.0.tar.gz")));
  const descriptor = await add("debian/synthetic/synthetic.dsc", `Format: 3.0 (native)\nSource: synthetic\nVersion: 1.0\nFiles:\n ${createHash("md5").update(await readFile(path.join(root, archive.path))).digest("hex")} ${archive.size} synthetic_1.0.tar.gz\nChecksums-Sha256:\n ${archive.sha256} ${archive.size} synthetic_1.0.tar.gz\n`);
  const rules = await add("build-info/synthetic/debian/rules", await readFile(path.join(stage, "synthetic-1.0/debian/rules")));
  const changelog = await add("build-info/synthetic/debian/changelog", await readFile(path.join(stage, "synthetic-1.0/debian/changelog")));
  const notice = await add("licenses/synthetic.txt", "Synthetic notice for test only.\n");
  const runtime = await add("runtime-inventory.json", JSON.stringify({ packages: [{ name: "synthetic-bin", version: "1.0+b1", source: "synthetic", sourceVersion: "1.0", copyrightSha256: notice.sha256 }], npm: [], binaries: [] }));
  const manifest: NativeManifest = { schema: 2, version: "1.0.0", platform: "linux/amd64", imageId: `sha256:${"a".repeat(64)}`, applicationSourceSha256: "b".repeat(64), runtimeSha256: runtime.sha256,
    components: [{ name: "synthetic-bin", version: "1.0+b1", type: "deb", architecture: "amd64", location: null, source: "synthetic", sourceVersion: "1.0", license: "Synthetic test license", notices: [notice], sources: [archive.path, descriptor.path], sourceObligation: "required", evidence: "Synthetic source version mapping", status: "PASS" }],
    sourcePackages: [{ name: "synthetic", version: "1.0", descriptor: descriptor.path, files: [archive, descriptor], buildFiles: [rules, changelog], extraction: "PASS", signature: "NOT VERIFIED" }], materials: files, buildInfo: [rules, changelog], publication: { status: "NOT TESTED", intendedUrl: "https://example.invalid/native-synthetic_1.0.tar.gz" } };
  await rm(stage, { recursive: true });
  await writeChecksumManifest(root, manifest);
  return { root, manifest, archive, descriptor, notice };
}

describe("independent native source validation", () => {
  it("verifies archive readability, exact source identity and extracted build material", async () => {
    const { root } = await fixture();
    try { expect((await validateNativeBundle(root)).technical).toBe("PASS"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["missing", "checksum", "version", "archive", "build", "runtime", "extra", "notice", "release"])("rejects %s defects", async (defect) => {
    const { root, manifest, archive, notice } = await fixture();
    try {
      if (defect === "missing") await rm(path.join(root, archive.path));
      if (defect === "checksum") await writeFile(path.join(root, archive.path), "changed");
      if (defect === "version") manifest.sourcePackages[0].version = "2.0";
      if (defect === "archive") {
        const data = "Not a compressed archive."; await writeFile(path.join(root, archive.path), data);
        archive.sha256 = createHash("sha256").update(data).digest("hex"); archive.size = data.length;
        const descriptor = manifest.materials.find((file) => file.path.endsWith(".dsc"))!;
        const dsc = `Format: 3.0 (native)\nSource: synthetic\nVersion: 1.0\nFiles:\n ${createHash("md5").update(await readFile(path.join(root, archive.path))).digest("hex")} ${archive.size} synthetic_1.0.tar.gz\nChecksums-Sha256:\n ${archive.sha256} ${archive.size} synthetic_1.0.tar.gz\n`;
        await writeFile(path.join(root, descriptor.path), dsc); descriptor.sha256 = createHash("sha256").update(dsc).digest("hex"); descriptor.size = dsc.length;
      }
      if (defect === "build") {
        const file = manifest.buildInfo[0]; await writeFile(path.join(root, file.path), "wrong build material\n"); file.sha256 = createHash("sha256").update("wrong build material\n").digest("hex"); file.size = 21;
      }
      if (defect === "runtime") manifest.components[0].version = "1.0+b2";
      if (defect === "extra") await writeFile(path.join(root, "private.env"), "SYNTHETIC_ONLY=example");
      if (defect === "notice") await rm(path.join(root, notice.path));
      if (defect === "release") manifest.version = "1.1.0";
      await writeChecksumManifest(root, manifest);
      await expect(validateNativeBundle(root)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a legal-review issue distinct from successful technical integrity", async () => {
    const { root, manifest } = await fixture();
    try {
      manifest.components[0].status = "LEGAL REVIEW REQUIRED";
      await writeChecksumManifest(root, manifest);
      const result = await validateNativeBundle(root);
      expect(result.technical).toBe("PASS"); expect(result.compliance).toBe("LEGAL REVIEW REQUIRED"); expect(result.issues).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("binds the bundle to the expected actual image and fresh inventory", async () => {
    const { root, manifest } = await fixture();
    try { await expect(validateNativeBundle(root, { ...manifest, imageId: `sha256:${"c".repeat(64)}` })).rejects.toThrow("another image"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not treat process ASLR addresses as changes to the shipped libraries", () => {
    expect(runtimeIdentity({ linkage: "libc.so (0x1234)", texts: [{ path: "LICENSE", text: "notice", sha256: "a" }] })).toBe(runtimeIdentity({ linkage: "libc.so (0xabcd)", texts: [{ path: "LICENSE", text: "notice", sha256: "a" }] }));
  });
  it.each(["../private", "/etc/passwd", ".git/config", ".env.local", "licenses/../../secret", "a\\b"])("rejects non-public material path %s", (name) => { expect(() => materialPath(name)).toThrow(); });
});
