import { describe, expect, it } from "vitest";

import { dscFiles, sourceRequests } from "../../scripts/release/collect-native-sources.mts";

describe("exact native source acquisition", () => {
  it("deduplicates source packages while retaining exact source epochs and versions", () => {
    const item = { name: "synthetic-codec", version: "1.0-1+b1", source: "synthetic-codec", sourceVersion: "2:1.0-1", copyrightSha256: "a".repeat(64) };
    expect(sourceRequests({ native: { node: "synthetic", bundleSha256: null, packages: [item, { ...item, name: "synthetic-tools" }] } })).toEqual([{ source: item.source, version: item.sourceVersion }]);
    expect(() => sourceRequests({ native: { node: "synthetic", bundleSha256: null, packages: [{ ...item, source: "../private" }] } })).toThrow();
  });
  const descriptor = `\nSource: synthetic-codec\nVersion: 2:1.0-1\nChecksums-Sha256:\n ${"a".repeat(64)} 123 synthetic-codec_1.0.orig.tar.xz\n ${"b".repeat(64)} 45 synthetic-codec_1.0-1.debian.tar.xz\n`;
  it("requires original source and Debian patch/build archive checksums from the exact descriptor", () => {
    expect(dscFiles(descriptor, "synthetic-codec", "2:1.0-1")).toHaveLength(2);
  });
  it("rejects a substituted version and missing checksums", () => {
    expect(() => dscFiles(descriptor, "synthetic-codec", "2:1.0-2")).toThrow("identity");
    expect(() => dscFiles("\nSource: synthetic-codec\nVersion: 2:1.0-1\n", "synthetic-codec", "2:1.0-1")).toThrow("inventory");
  });
  it("rejects paths outside the acquisition directory", () => {
    expect(() => dscFiles(descriptor.replace("synthetic-codec_1.0.orig.tar.xz", "../private"), "synthetic-codec", "2:1.0-1")).toThrow("Unsafe");
  });
});
