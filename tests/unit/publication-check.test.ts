import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkPublication, isPublicPath, publicationIssues } from "../../scripts/publication-check.mts";
import policy from "../../scripts/publication-policy.json";

describe("publication policy", () => {
  it("contains only public path rules and the reviewed public test-key pin", () => {
    expect(Object.keys(policy).sort()).toEqual([
      "publicDirectories", "publicFiles", "publicDocs", "excluded", "testKey", "testKeySha256",
    ].sort());
    // No opaque installation-specific digest list may return under another field name.
    const digests = JSON.stringify(policy).match(/\b[0-9a-f]{64}\b/g);
    expect(digests).toEqual([policy.testKeySha256]);
  });
  it("keeps source/examples while excluding private working reports and agent instructions", () => {
    for (const file of ["src/app/layout.tsx", "tests/support/protect-fixtures.ts", ".env.example", "docs/selfhosting.md", "public/notices/Geist-OFL.txt"]) expect(isPublicPath(file)).toBe(true);
    for (const file of ["AGENTS.md", "docs/release/v1-readiness.md", "docs/selfhosting-validation.md", ".env.local"]) expect(isPublicPath(file)).toBe(false);
  });
  it("allows the explicit public fake TLS key, synthetic MACs and generated migration metadata", () => {
    expect(publicationIssues("tests/support/tls/test-only-localhost.key", readFileSync("tests/support/tls/test-only-localhost.key"))).toEqual([]);
    expect(publicationIssues("tests/support/example.ts", Buffer.from('const mac = "020000000001"; const ip = "192.0.2.1";'))).toEqual([]);
    expect(publicationIssues("drizzle/meta/_journal.json", Buffer.from('{"version":"7"}'))).toEqual([]);
  });
  it("flags accidentally tracked secret/data files without printing their contents", () => {
    expect(publicationIssues(".env.local", Buffer.from("password=hidden"))).toContain("tracked private environment file");
    expect(publicationIssues("private.key", Buffer.from("-----BEGIN PRIVATE KEY-----"))).toContain("private key outside documented test fixture");
    expect(publicationIssues("recordings/private.mp4", Buffer.from([0, 1]))).toContain("binary/data artifact requires explicit publication review");
  });

  it.each(["backups/archive.dump", "backups/archive.backup", "archive.sqlite", "archive.db", "exports/video.mov", "exports/video.mkv"])("flags unreviewed data artifacts: %s", (file) => {
    expect(publicationIssues(file, Buffer.from("synthetic artifact"))).toContain("binary/data artifact requires explicit publication review");
  });

  it("detects keys embedded in source and token-shaped values", () => {
    const key = ["-----BEGIN " + "PRIVATE KEY-----", "synthetic", "-----END " + "PRIVATE KEY-----"].join("\n");
    expect(publicationIssues("src/example.ts", Buffer.from(key))).toContain("private key outside documented test fixture");
    expect(publicationIssues("src/example.ts", Buffer.from("glpat-" + "x".repeat(20)))).toContain("token-shaped value requires secret review");
    expect(publicationIssues("tests/support/tls/test-only-localhost.key", Buffer.from(key))).toContain("documented test key changed; review fixture provenance");
  });

  it("allows legitimate source and synthetic network/device examples", () => {
    const example = 'export const camera = { name: "Driveway", id: "660000000000000000000001", ip: "198.51.100.10" };';
    expect(publicationIssues("src/example.ts", Buffer.from(example))).toEqual([]);
  });

  it("works from a fresh synthetic Git index without private files or installation configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "unifi-publication-check-"));
    try {
      // Index-only fixture repository, not a source export; no commits, remotes or publication.
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src/example.ts"), 'export const name = "Driveway";\n');
      await writeFile(path.join(root, ".env.example"), "UNIFI_PROTECT_API_KEY=\n");
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["add", "src/example.ts", ".env.example"], { cwd: root });
      expect(await checkPublication(root)).toEqual({ files: 2, publicFiles: 2, findings: [] });

      await writeFile(path.join(root, ".env.local"), "SYNTHETIC_PASSWORD=example-only\n");
      execFileSync("git", ["add", ".env.local"], { cwd: root });
      expect((await checkPublication(root)).findings).toEqual([
        { file: ".env.local", issues: ["tracked private environment file"] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the CI publication job independent of private configuration", () => {
    const ci = readFileSync(".gitlab-ci.yml", "utf8");
    const job = ci.match(/^publication:\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/m)?.[1];
    expect(job).toContain("npm run publication:check");
    expect(job).not.toMatch(/variables:|PRIVATE|FINGERPRINT|PUBLICATION_FILE_LIST/);
  });
});
