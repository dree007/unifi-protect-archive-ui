import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "../../scripts/publication-check.mts";
import policy from "../../scripts/publication-policy.json";
import { REGISTRY_IMAGE, REPOSITORY } from "../../scripts/release/metadata.mts";
import packageMetadata from "../../package.json";

// Every Markdown document that ships in the public source export.
const PUBLIC_DOCS = [
  ...policy.publicFiles.filter((file) => file.endsWith(".md")),
  ...policy.publicDocs.map((name) => `docs/${name}`),
];
const read = (file: string) => readFileSync(file, "utf8");
const version = packageMetadata.version;

describe("public documentation", () => {
  it("ships only public documents", () => {
    expect(PUBLIC_DOCS).toEqual(expect.arrayContaining(["README.md", "SECURITY.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]));
    for (const file of PUBLIC_DOCS) {
      expect(existsSync(file), file).toBe(true);
      expect(isPublicPath(file), file).toBe(true);
    }
  });

  it.each(PUBLIC_DOCS)("%s links only to files of the public export", (file) => {
    const links = [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
    for (const link of links.filter((target) => !/^(https?:|mailto:|#)/.test(target))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link.split("#")[0]));
      expect(existsSync(target), `${file} -> ${link}`).toBe(true);
      expect(isPublicPath(target), `${file} -> ${link}`).toBe(true);
    }
  });

  it.each(PUBLIC_DOCS)("%s describes the released state, not a pending one", (file) => {
    expect(read(file)).not.toMatch(
      /being prepared|not yet (?:released|available|public|verified|announced|active)|—\s*Unreleased|publication (?:date )?(?:is )?pending|announced release|planned (?:prebuilt|registry|image|default|distribution|v1|private)/i,
    );
  });
});

describe("public source", () => {
  it("never points to private release records", () => {
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "src", "scripts", "e2e", ".gitlab-ci.yml", "Dockerfile", "compose.yaml"], { encoding: "utf8" })
      .split("\n").filter((file) => file && isPublicPath(file) && file !== "scripts/publication-policy.json");
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((file) => read(file).includes("docs/release/"))).toEqual([]);
  });
});

describe("README", () => {
  const readme = read("README.md");

  it("stays short and links to the detailed guides, security policy and licenses", () => {
    expect(readme.split("\n").length).toBeLessThanOrEqual(90);
    for (const link of ["SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/selfhosting.md", "docs/security.md", "CHANGELOG.md"]) {
      expect(readme).toContain(`](${link})`);
    }
    expect(readme).toContain("AGPL-3.0-only");
    expect(readme).toMatch(/no login/i);
    expect(readme).toMatch(/not affiliated with/i);
  });

  it("installs the released version with the settings that .env.example defines", () => {
    for (const file of ["compose.yaml", ".env.example"]) {
      expect(readme).toContain(`https://raw.githubusercontent.com/${REPOSITORY.replace("https://github.com/", "")}/v${version}/${file}`);
    }
    expect(read("compose.yaml")).toContain(`\${UNIFI_ARCHIVE_IMAGE:-${REGISTRY_IMAGE}:${version}}`);
    const env = read(".env.example");
    for (const key of ["POSTGRES_PASSWORD", "NAS_ARCHIVE_HOST_PATH"]) {
      expect(readme).toContain(key);
      expect(env).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(env).toMatch(/^UNIFI_ARCHIVE_PORT=3100$/m);
    expect(readme).toContain(":3100");
  });

  it("keeps CI, compliance and implementation details in the separate documentation", () => {
    expect(readme).not.toMatch(/GitLab|DinD|native-compliance|publishing gate|npm run|corresponding source/i);
  });
});

describe("release documents", () => {
  it("records the package version as the released changelog entry", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"));
  });

  it("names the private vulnerability-reporting channel and the supported line", () => {
    const security = read("SECURITY.md");
    expect(security).toContain(`${REPOSITORY}/security/advisories/new`);
    expect(security).toMatch(/^\| 1\.0\.x \| Supported \|$/m);
    expect(security).toContain(REGISTRY_IMAGE);
  });

  it("documents the version's source downloads beside the image", () => {
    expect(read("docs/native-sources.md")).toContain(`${REPOSITORY}/releases/tag/v${version}`);
    for (const file of ["source.tar.gz", "native-source.tar.gz"]) expect(read("CHANGELOG.md")).toContain(file);
  });
});
