import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fileDigest, releaseImageTag, REPOSITORY, type ReleaseManifest } from "./metadata.mts";
import { inspectRuntimeLayers } from "./layers.mts";
import { regularFile, verifiedSourceFile } from "./source.mts";
import { canonicalRuntime, inspectRuntime, materialPath, run, validateNativeBundle, writeChecksumManifest, type MaterialFile, type NativeManifest, type RuntimeComponent, type SourcePackage } from "./native-compliance.mts";

interface RawRuntime {
  architecture: string;
  node: { version: string; components: Record<string, string> };
  packages: { name: string; version: string; architecture: string; source: string; sourceVersion: string; notice: string; copyrightSha256: string }[];
  npm: { name: string; version: string; license: string | null; directory: string }[];
  compiledDependencies?: { name: string; version: string; license: string }[];
  fonts?: { path: string; sha256: string; license: string; notice: string }[];
  texts: { path: string; text: string; sha256: string }[];
  binaries: { path: string }[];
  ffmpeg: { version: string; configuration: string; license: string; linkage: string };
}

function declaredLicense(text: string) {
  const paragraphs = text.split(/\n\s*\n/);
  const main = paragraphs.find((paragraph) => /^Files:\s*\*\s*$/m.test(paragraph));
  return /^License:\s*(.+)$/m.exec(main ?? "")?.[1] ?? null;
}
// Prose records and library/tool splits need explicit interpretation, not a GPL keyword scan.
const sourceLicenses: Record<string, string> = {
  "base-files": "GPL-2.0-or-later", "debian-archive-keyring": "GPL-2.0-or-later (keyring data uncopyrighted)",
  "gcc-12": "GPL-3.0-or-later WITH GCC-exception-3.1; other file terms", "glibc": "LGPL-2.1-or-later; GPL tools and other file terms",
  "fontconfig": "MIT-like fontconfig notice", "cairo": "LGPL-2.1-or-later OR MPL-1.1; other file terms",
  "libcdio-paranoia": "GPL-3.0-or-later", "libxcrypt": "LGPL-2.1-or-later; other file terms",
  "krb5": "MIT/BSD and other retained file terms", "flite": "BSD-like and retained voice/file terms",
  "libdrm": "MIT and other retained file terms", "libdc1394": "LGPL-2.1-or-later", "libiec61883": "LGPL-2.1-or-later",
  "libgcrypt20": "LGPL-2.1-or-later; GPL tools", "gnutls28": "LGPL-3.0-or-later OR GPL-2.0-or-later; other file terms",
  "numactl": "LGPL-2.1/GPL file-specific terms", "libpciaccess": "MIT and retained file terms", "pixman": "MIT and retained file terms",
  "libraw1394": "LGPL-2.1-or-later", "libselinux": "public-domain library; GPL tool/file terms", "libsemanage": "LGPL-2.1-or-later; GPL packaging",
  "lm-sensors": "LGPL-2.1-or-later library; GPL tools", "libtasn1-6": "LGPL-2.1-or-later library; GPL tools",
  "libusb-1.0": "LGPL-2.1-or-later", "libwebp": "BSD-3-Clause", "xorg": "MIT and retained file terms",
  "xkeyboard-config": "MIT-like X11 notices; other retained file terms", "findutils": "GPL-3.0-or-later; GFDL documentation",
  "libidn2": "LGPL-3.0-or-later OR GPL-2.0-or-later library; GPL tools",
};
/** Application build material taken from the release source snapshot into build-info/application. */
export const APPLICATION_BUILD_FILES = ["Dockerfile", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"];
const permissiveSources = new Set(["fontconfig", "libdrm", "libpciaccess", "pixman", "libwebp", "xorg", "xkeyboard-config", "krb5", "flite"]);
const nodeLicenses: Record<string, string> = {
  acorn: "MIT", ada: "MIT (as redistributed in Node LICENSE)", amaro: "MIT", ares: "MIT", brotli: "MIT",
  cldr: "Unicode-3.0", icu: "Unicode-3.0 and retained third-party terms", llhttp: "MIT", merve: "MIT",
  nbytes: "MIT (Node core)", ncrypto: "MIT (Node core) and Apache-2.0 (OpenSSL)", nghttp2: "MIT",
  openssl: "Apache-2.0", simdjson: "Apache-2.0", simdutf: "MIT OR Apache-2.0", sqlite: "public-domain",
  tz: "public-domain tz data", undici: "MIT", uv: "MIT", uvwasi: "MIT", v8: "BSD-3-Clause and retained third-party terms",
  zlib: "Zlib", zstd: "BSD-3-Clause (as redistributed in Node LICENSE)",
};
const noticeAliases: Record<string, string[]> = {
  "@next/env": ["/app/notices/npm/next/license.md"],
  "client-only": ["/app/notices/npm/react/LICENSE"],
  "@edge-runtime/cookies": ["/app/notices/npm/next/license.md"],
  "@edge-runtime/ponyfill": ["/app/notices/npm/next/license.md"],
  "@edge-runtime/primitives": ["/app/notices/npm/next/license.md"],
  "pgpass": ["/app/public/notices/runtime/pgpass-LICENSE.txt"],
  "pg-types": ["/app/public/notices/runtime/pg-types-LICENSE.txt"],
  "@sigstore/verify": ["/app/public/notices/runtime/sigstore-verify-LICENSE"],
  "spdx-exceptions": ["/app/public/notices/runtime/spdx-exceptions-NOTICE.md"],
  "spdx-license-ids": ["/app/public/notices/runtime/spdx-license-ids-README.md"],
  "@npmcli/agent": ["/app/public/notices/runtime/npmcli-agent-metadata.json"],
  "drizzle-orm": ["/app/public/notices/runtime/drizzle-orm-LICENSE"],
  "server-only": ["/app/notices/npm/react/LICENSE"],
};

export async function assembleNativeBundle(options: { releaseDirectory: string; input: string; output: string; extractionEvidence: string; signatureEvidence: string; archive?: boolean }) {
  const release: ReleaseManifest = JSON.parse(await readFile(path.join(options.releaseDirectory, "release.json"), "utf8"));
  const input = path.resolve(options.input), output = path.resolve(options.output);
  if (input === output || output.startsWith(input + path.sep)) throw new Error("Bundle output must be separate from the retained source cache.");
  await mkdir(output, { recursive: true });
  // Fail before the long assembly when the application source snapshot is missing or differs.
  for (const file of APPLICATION_BUILD_FILES) await verifiedSourceFile(options.releaseDirectory, release.source.sha256, file);
  const layerEvidence = await inspectRuntimeLayers(release.image.id);
  const raw: RawRuntime = inspectRuntime(release.image.id);
  if (raw.architecture !== "x64" || raw.node.version !== release.native.node || raw.packages.length !== release.native.packages.length || raw.packages.some((item) => !release.native.packages.some((entry) => ["name", "version", "source", "sourceVersion", "copyrightSha256"].every((key) => item[key as keyof typeof item] === entry[key as keyof typeof entry])))) throw new Error("Fresh image inventory differs from the release ledger.");
  if (raw.binaries.some((binary) => binary.path !== "/usr/local/bin/node")) throw new Error("Unexpected native addon/library; component/source review required.");
  const materials = new Map<string, MaterialFile>();
  async function add(name: string, content?: string, from?: string) {
    materialPath(name);
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (content !== undefined) await writeFile(target, content);
    else if (from) {
      // Inputs are selected file-by-file; private sibling files are never mirrored.
      await regularFile(path.dirname(from), path.basename(from));
      await copyFile(from, target);
    } else throw new Error("Source material has no input.");
    const file = { path: name, sha256: await fileDigest(target), size: (await stat(target)).size };
    materials.set(name, file); return file;
  }
  const noticeFiles = new Map<string, MaterialFile>();
  const sharedNotices = new Map<string, MaterialFile>();
  for (const text of raw.texts) {
    let file = sharedNotices.get(text.sha256);
    if (!file) { file = await add(`licenses${text.path}`, text.text); sharedNotices.set(text.sha256, file); }
    noticeFiles.set(text.path, file);
  }
  const inventory = canonicalRuntime(raw);
  const runtimeFile = await add("runtime-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
  const extraction: { descriptor: string; extractExit: number; buildRules: boolean; changelog: boolean }[] = JSON.parse(await readFile(options.extractionEvidence, "utf8"));
  const signatures: { descriptor: string; verified: boolean }[] = JSON.parse(await readFile(options.signatureEvidence, "utf8"));
  const sourcePackages: SourcePackage[] = [];
  const components: RuntimeComponent[] = [];
  const identities = new Map(release.native.packages.map((item) => [`${item.source}=${item.sourceVersion}`, item]));
  for (const item of identities.values()) {
    const directory = `debian/${item.source}_${encodeURIComponent(item.sourceVersion)}`;
    const names = (await readdir(path.join(input, directory))).filter((name) => name.endsWith(".dsc"));
    if (names.length !== 1) throw new Error(`Missing or duplicate source descriptor: ${item.source}`);
    const descriptor = `${directory}/${names[0]}`;
    const evidence = extraction.find((entry) => entry.descriptor === descriptor);
    if (!evidence || evidence.extractExit !== 0 || !evidence.buildRules || !evidence.changelog) throw new Error(`Source extraction/build evidence missing: ${item.source}`);
    const text = await readFile(path.join(input, descriptor), "utf8");
    const { dscFiles } = await import("./collect-native-sources.mts");
    const entries = dscFiles(text, item.source, item.sourceVersion);
    const files = [];
    for (const entry of [...entries, { path: names[0], sha256: await fileDigest(path.join(input, descriptor)), size: (await stat(path.join(input, descriptor))).size }]) {
      const file = await add(`${directory}/${entry.path}`, undefined, path.join(input, directory, entry.path));
      if (file.sha256 !== entry.sha256 || file.size !== entry.size) throw new Error(`Source acquisition checksum mismatch: ${item.source}`);
      files.push(file);
    }
    const extracted = path.join(path.dirname(options.extractionEvidence), "extracted", path.posix.basename(directory));
    const buildFiles = [];
    for (const name of ["rules", "changelog", "copyright", "copyright.in", "copyright.debian", "control"]) {
      const file = path.join(extracted, "debian", name);
      try { if ((await stat(file)).isFile()) buildFiles.push(await add(`build-info/${path.posix.basename(directory)}/debian/${name}`, undefined, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    sourcePackages.push({ name: item.source, version: item.sourceVersion, descriptor, files, buildFiles, extraction: "PASS", signature: signatures.find((entry) => entry.descriptor === descriptor)?.verified ? "PASS" : "NOT VERIFIED" });
  }
  for (const item of raw.packages) {
    const source = sourcePackages.find((entry) => entry.name === item.source && entry.version === item.sourceVersion)!;
    const text = raw.texts.find((entry) => entry.path === item.notice)!.text;
    const license = item.source === "ffmpeg" ? (raw.ffmpeg.configuration.includes("--enable-gpl") ? "GPL-2.0-or-later (actual ffmpeg build); other source-file terms" : "LGPL-2.1-or-later") : sourceLicenses[item.source] ?? declaredLicense(text) ?? `LicenseRef-Debian-${item.source}`;
    const permissive = permissiveSources.has(item.source) || /^(?:MIT|ISC|Expat|BSD-[23]|Apache-2|Zlib|X11|public-domain|PD|WTFPL)/.test(license);
    components.push({ name: item.name, version: item.version, type: "deb", architecture: item.architecture, location: null, source: item.source, sourceVersion: item.sourceVersion, license, notices: [noticeFiles.get(item.notice)!], sources: source.files.map((file) => file.path), sourceObligation: permissive ? "supplementary" : "required", evidence: `Full versioned Debian copyright record; exact .dsc/archives and packaging retained. File-specific terms govern; the summary does not relicense subsidiary code.`, status: "PASS" });
  }
  const nodeSource = await add("node/node-v24.21.0.tar.xz", undefined, path.join(input, "upstream/node-v24.21.0.tar.xz"));
  const nodeChecksum = await add("build-info/node-SHASUMS256.txt", undefined, path.join(path.dirname(options.extractionEvidence), "node-checksums.txt"));
  if (!(await readFile(path.join(output, nodeChecksum.path), "utf8")).includes(`${nodeSource.sha256}  node-v24.21.0.tar.xz`)) throw new Error("Node source does not match its official checksum.");
  if (raw.node.version !== "v24.21.0") throw new Error("Node source version changed; acquire its exact source/checksum.");
  components.push({ name: "node", version: raw.node.version, type: "native", architecture: "amd64", location: "/usr/local/bin/node", source: "node", sourceVersion: raw.node.version, license: "MIT and bundled terms in the exact Node LICENSE", notices: [noticeFiles.get("/usr/local/LICENSE")!], sources: [nodeSource.path], sourceObligation: "supplementary", evidence: "Pinned official Node base; process.versions/configuration and complete upstream bundled notice retained. Preferred source supplied as supplementary material.", status: "PASS" });
  for (const [name, version] of Object.entries(raw.node.components)) {
    if (!version || ["node", "modules", "napi", "unicode"].includes(name)) continue;
    const license = nodeLicenses[name];
    if (!license) throw new Error(`New bundled Node component requires classification: ${name}`);
    components.push({ name: `node:${name}`, version, type: "node-bundled", architecture: "amd64", location: null, source: "node", sourceVersion: raw.node.version, license, notices: [noticeFiles.get("/usr/local/LICENSE")!], sources: [nodeSource.path], sourceObligation: "supplementary", evidence: "Version reported by the actual Node binary; exact per-component terms/copyright are in Node LICENSE and matching vendored preferred source. Not the application's AGPL license.", status: "PASS" });
  }
  const npmSource = raw.npm.some((item) => item.directory.startsWith("/usr/local/"))
    ? await add("node/npm-preferred.tar.gz", undefined, path.join(input, "upstream/npm-preferred.tar.gz")) : undefined;
  for (const item of raw.npm) {
    const direct = raw.texts.filter((text) => text.path.startsWith(item.directory + "/") && !text.path.slice(item.directory.length + 1).includes("node_modules/"));
    const traced = item.directory.startsWith("/app/node_modules/") ? raw.texts.filter((text) => text.path.startsWith("/app/notices/npm/" + item.directory.slice("/app/node_modules/".length) + "/")) : [];
    const aliases = (noticeAliases[item.name] ?? []).map((name) => raw.texts.find((text) => text.path === name)).filter((entry) => entry !== undefined);
    const notices = [...new Set([...direct, ...traced, ...aliases].map((entry) => entry.path))].map((name) => noticeFiles.get(name)!);
    if (!notices.length) throw new Error(`Runtime package has no notice evidence: ${item.name}`);
    const license = item.name === "qrcode-terminal" ? "Apache-2.0 AND MIT (vendor QRCode)" : item.license;
    if (!license) throw new Error(`Runtime package has no license classification: ${item.name}`);
    const review = item.name === "@npmcli/agent";
    components.push({ name: item.name, version: item.version, type: "npm", architecture: "all", location: item.directory, source: item.name, sourceVersion: item.version, license, notices, sources: item.directory.startsWith("/usr/local/") ? [npmSource!.path] : [], sourceObligation: review ? "review" : "supplementary", evidence: review ? "Exact published source/package metadata declares ISC but supplies no copyright/permission notice; retained original author metadata is not a fabricated copyright grant. Confirm notice obligations with upstream or qualified reviewer." : "Exact installed package metadata and retained original license/notice; permissive/data terms do not generally require a standalone preferred-source archive. Parent-package notices are mapped explicitly.", status: review ? "LEGAL REVIEW REQUIRED" : "PASS" });
  }
  for (const item of raw.compiledDependencies ?? []) {
    if (components.some((component) => component.name === item.name && component.version === item.version)) continue;
    const prefix = `/app/notices/npm/${item.name}/`;
    const notices = [...raw.texts.filter((text) => text.path.startsWith(prefix)), ...(noticeAliases[item.name] ?? []).map((name) => raw.texts.find((text) => text.path === name)).filter((entry) => entry !== undefined)].map((text) => noticeFiles.get(text.path)!);
    if (!notices.length || !item.license) throw new Error(`Compiled dependency notice/license missing: ${item.name}`);
    components.push({ name: item.name, version: item.version, type: "bundled", architecture: "all", location: null, source: item.name, sourceVersion: item.version, license: item.license, notices, sources: [], sourceObligation: "supplementary", evidence: "Actual esbuild inputs or application source imports/CSS traced into the compiled distribution; separate from unused build-tool notice copies.", status: "PASS" });
  }
  for (const font of raw.fonts ?? []) {
    components.push({ name: "Geist font asset", version: `sha256:${font.sha256}`, type: "font", architecture: "all", location: font.path, source: null, sourceVersion: null, license: font.license, notices: [noticeFiles.get(font.notice)!], sources: [], sourceObligation: "supplementary", evidence: "Actual WOFF2 asset from the existing Next/font Geist/Geist Mono build; exact identity is its digest, not an invented semantic font version. Original OFL notice retained.", status: "PASS" });
  }
  const buildInfo = [await add("build-info/layer-validation.json", JSON.stringify(layerEvidence, null, 2) + "\n"), nodeChecksum, await add("build-info/ffmpeg-version.txt", raw.ffmpeg.version), await add("build-info/ffmpeg-buildconf.txt", raw.ffmpeg.configuration), await add("build-info/ffmpeg-linkage.txt", inventory.ffmpeg.linkage), await add("build-info/ffmpeg-license.txt", raw.ffmpeg.license)];
  if (raw.ffmpeg.configuration.includes("--enable-nonfree")) throw new Error("Nonfree ffmpeg build cannot pass this distribution gate.");
  // Application build material must be the exact source the image was built from (its source label).
  for (const file of APPLICATION_BUILD_FILES) buildInfo.push(await add(`build-info/application/${file}`, undefined, await verifiedSourceFile(options.releaseDirectory, release.source.sha256, file)));
  buildInfo.push(await add("build-info/LGPL-REPLACEMENT.md", "# Library replacement\n\nThe application invokes ffmpeg as a separate executable. Native shared libraries retain their own\nlicense terms. Operators may rebuild/replace them and inspect/reverse-engineer the combined work\nfor debugging modifications where their licenses permit it. The read-only container filesystem is\na runtime safeguard, not a prohibition on rebuilding a derived image. Exact Debian sources and\npackaging are included. Use the matching application source/Dockerfile and compatible ABI versions;\na replacement build is not covered by this release's functional certification.\n"));
  await add("README.md", `# Native sources for Unifi Protect Archive UI ${release.version}\n\nLocal image ID: ${release.image.id}\nPlatform: linux/amd64. Registry digest: not published.\n\nRun sha256sum -c SHA256SUMS, then node scripts/release/validate-native.mts with\nNATIVE_BUNDLE_DIRECTORY set to this directory. The latter script is in matching application source.\nDebian sources retain original .dsc/original/patch archives and exact source versions.\nBuild material is in build-info; full licenses are in licenses; runtime/matrix data is in manifest.json.\nUse dpkg-source -x on a descriptor in an isolated build workspace, then follow debian/rules/control.\nCompilers and external build tools are not all redistributed runtime components.\n\nMIT/BSD/Apache/ISC and data-license sources included here are supplementary where no source duty\narises. File-specific terms and copyright records govern. This bundle complements application\nsource.tar.gz; it does not replace AGPL corresponding source. Required public downloads are still\nNOT TESTED. No private Git history, env files, installation data or build logs are included.\n`);
  const manifest: NativeManifest = { schema: 2, version: release.version, platform: "linux/amd64", imageId: release.image.id, applicationSourceSha256: release.source.sha256, runtimeSha256: runtimeFile.sha256, components, sourcePackages, materials: [...materials.values()].sort((a, b) => a.path.localeCompare(b.path)), buildInfo, publication: { status: "NOT TESTED", intendedUrl: `${REPOSITORY}/releases/download/v${release.version}/native-source.tar.gz` } };
  await writeChecksumManifest(output, manifest);
  const validation = await validateNativeBundle(output, { imageId: release.image.id, version: release.version, applicationSourceSha256: release.source.sha256 });
  const reportPath = path.join(options.releaseDirectory, "native-compliance.json");
  let archiveSha256: string | null = null, archiveSize = 0;
  if (options.archive !== false) {
    const archive = path.join(options.releaseDirectory, "native-source.tar.gz");
    await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", output, "."]);
    archiveSha256 = await fileDigest(archive); archiveSize = (await stat(archive)).size;
  }
  const report = { ...validation, archiveSha256, archiveSize };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const dockerfile = await readFile(await verifiedSourceFile(options.releaseDirectory, release.source.sha256, "Dockerfile"), "utf8");
  await writeFile(path.join(options.releaseDirectory, "release-assets.json"), JSON.stringify({ version: release.version, platform: release.platform, sourceRepository: REPOSITORY, image: releaseImageTag(release.version), imageId: release.image.id, registryDigest: null, baseImage: /^FROM (debian:[^ ]+) AS runtime$/m.exec(dockerfile)?.[1] ?? null, nodeImage: /^ARG NODE_IMAGE=(.+)$/m.exec(dockerfile)?.[1] ?? null, publicRevision: release.source.revision || null, sourceSha256: release.source.sha256, applicationArchiveSha256: release.source.archiveSha256, nativeSource: { sha256: archiveSha256, size: archiveSize, url: manifest.publication.intendedUrl, availability: "NOT TESTED", compliance: report.compliance }, inventorySha256: runtimeFile.sha256, manifestSha256: report.manifestSha256, buildInfo: buildInfo.map((file) => file.path) }, null, 2) + "\n");
  console.log(`Native source bundle: ${components.length} components, ${sourcePackages.length} source versions; technical ${report.technical}, compliance ${report.compliance}.`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await assembleNativeBundle({ releaseDirectory: path.resolve(process.env.RELEASE_OUTPUT ?? ".cache/release"), input: path.resolve(process.env.NATIVE_SOURCE_DIRECTORY ?? ".cache/native-input"), output: path.resolve(process.env.NATIVE_BUNDLE_DIRECTORY ?? ".cache/release-sources"), extractionEvidence: path.resolve(process.env.NATIVE_EXTRACTION_EVIDENCE ?? ".cache/native-input/source-extraction.json"), signatureEvidence: path.resolve(process.env.NATIVE_SIGNATURE_EVIDENCE ?? ".cache/native-input/dsc-signatures.json") });
}
