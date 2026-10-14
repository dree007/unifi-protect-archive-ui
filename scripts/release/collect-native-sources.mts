import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fileDigest, type ReleaseManifest } from "./metadata.mts";

/** Debian source versions include epochs; binary-only rebuild suffixes must not be substituted. */
export function sourceRequests(manifest: Pick<ReleaseManifest, "native">) {
  return [...new Map(manifest.native.packages.map(({ source, sourceVersion }) => {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(source) || !/^[a-zA-Z0-9][a-zA-Z0-9:.+~_-]*$/.test(sourceVersion)) throw new Error("Invalid Debian source identity.");
    return [`${source}=${sourceVersion}`, { source, version: sourceVersion }];
  })).values()].sort((a, b) => a.source.localeCompare(b.source));
}

export function dscFiles(text: string, source: string, version: string) {
  if (!text.includes(`\nSource: ${source}\n`) || !text.includes(`\nVersion: ${version}\n`)) throw new Error("Downloaded source identity differs from the runtime ledger.");
  const section = /\nChecksums-Sha256:\n((?: [^\n]+\n)+)/.exec(text)?.[1];
  if (!section) throw new Error("Source descriptor has no SHA-256 file inventory.");
  return section.trim().split("\n").map((line) => {
    const match = /^\s*([a-f0-9]{64})\s+(\d+)\s+([a-zA-Z0-9][a-zA-Z0-9._+~:-]*)$/.exec(line);
    if (!match || match[3].includes("..")) throw new Error("Unsafe source archive entry.");
    return { sha256: match[1], size: Number(match[2]), path: match[3] };
  });
}

async function collect() {
  const manifest: ReleaseManifest = JSON.parse(await readFile(process.env.RELEASE_MANIFEST ?? ".cache/release/release.json", "utf8"));
  const output = path.resolve(process.env.NATIVE_ACQUISITION_DIRECTORY ?? ".cache/native-acquisition");
  await mkdir(output, { recursive: true });
  const results: { source: string; version: string; status: string; files?: { path: string; sha256: string }[]; reason?: string }[] = [];
  // Run only in a disposable Debian acquisition environment with authenticated deb-src indexes.
  // Never enables repositories, upgrades a host or marks a legal review approved.
  for (const request of sourceRequests(manifest)) {
    const directory = path.join(output, `${request.source}_${encodeURIComponent(request.version)}`);
    await mkdir(directory, { recursive: true });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("apt-get", ["source", "--download-only", "-o", "Acquire::Retries=1", "-o", "Acquire::http::Timeout=30", "--", `${request.source}=${request.version}`], { cwd: directory, stdio: "ignore" });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
      });
      if (code !== 0) throw new Error("Exact version unavailable or authenticated APT download failed; no newer-version fallback.");
      const descriptors = (await readdir(directory)).filter((name) => name.endsWith(".dsc"));
      if (descriptors.length !== 1) throw new Error("Expected one exact source descriptor.");
      const descriptor = descriptors[0];
      const files = dscFiles(await readFile(path.join(directory, descriptor), "utf8"), request.source, request.version);
      for (const file of files) {
        const content = await readFile(path.join(directory, file.path));
        if (content.length !== file.size || createHash("sha256").update(content).digest("hex") !== file.sha256) throw new Error("Source archive checksum/size mismatch.");
      }
      results.push({ ...request, status: "PASS acquisition", files: [...files.map(({ path: name, sha256 }) => ({ path: path.relative(output, path.join(directory, name)), sha256 })), { path: path.relative(output, path.join(directory, descriptor)), sha256: await fileDigest(path.join(directory, descriptor)) }] });
    } catch (error) { results.push({ ...request, status: "FAIL", reason: error instanceof Error ? error.message : "Acquisition failed." }); }
    await writeFile(path.join(output, "acquisition.json"), JSON.stringify({ imageId: manifest.image.id, approved: false, results }, null, 2) + "\n");
    console.log(`${request.source} ${request.version}: ${results.at(-1)?.status}`);
  }
  console.log("Acquisition is not legal approval. Node/npm, bundled dependencies, source/build completeness and delivery still require review.");
  if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await collect();
