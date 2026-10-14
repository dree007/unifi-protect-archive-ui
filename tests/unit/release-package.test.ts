import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sourceUrl } from "@/lib/source-url";
import packageMetadata from "../../package.json";
import lock from "../../package-lock.json";

describe("release package", () => {
  it("keeps package, lock and image version/license metadata consistent", () => {
    expect(packageMetadata.version).toBe("1.0.0");
    expect(packageMetadata.license).toBe("AGPL-3.0-only");
    expect(lock.version).toBe(packageMetadata.version);
    expect(lock.packages[""].version).toBe(packageMetadata.version);
    expect(lock.packages[""].license).toBe(packageMetadata.license);
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain(`ARG RELEASE_VERSION=${packageMetadata.version}`);
    expect(dockerfile).toContain('org.opencontainers.image.version="${RELEASE_VERSION}"');
    expect(dockerfile).toContain(`org.opencontainers.image.licenses="${packageMetadata.license}"`);
  });

  it("retains the complete license and exact public notice copies", () => {
    const license = readFileSync("LICENSE");
    expect(license.toString()).toContain("13. Remote Network Interaction; Use with the GNU General Public License.");
    expect(license.toString()).toContain("END OF TERMS AND CONDITIONS");
    expect(readFileSync("public/notices/LICENSE.txt")).toEqual(license);
    expect(readFileSync("public/notices/THIRD_PARTY_NOTICES.md")).toEqual(readFileSync("THIRD_PARTY_NOTICES.md"));
    expect(readFileSync("public/notices/shadcn-LICENSE.txt")).toEqual(readFileSync("node_modules/shadcn/LICENSE.md"));
    // Public license-document provenance; never an installation identifier fingerprint.
    expect(createHash("sha256").update(license).digest("hex")).toBe("d8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee");
  });
});

describe("advertised source location", () => {
  it("accepts only explicit credential-free HTTPS locations", () => {
    expect(sourceUrl("https://source.example.com/releases/1.0.0")).toBe("https://source.example.com/releases/1.0.0");
    expect(sourceUrl("  https://source.example.com/project  ")).toBe("https://source.example.com/project");
  });

  it.each([undefined, "", "not-a-url", "javascript:alert(1)", "http://source.example.com", "https://user:secret@source.example.com", "https://source.example.com?access_token=synthetic", "https://source.example.com/#fragment"])("does not expose an invalid or credential-bearing source setting: %s", (value) => {
    expect(sourceUrl(value)).toBeNull();
  });
});
