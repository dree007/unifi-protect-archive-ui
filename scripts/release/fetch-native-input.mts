import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import { fileDigest } from "./metadata.mts";
import { extractNativeArchive } from "./native-compliance.mts";

export function nativeInputRequest(value: string, checksum: string, env: Record<string, string | undefined>) {
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Release compliance needs a controlled native input URL and SHA-256.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Native input URL must be credential-free HTTPS.");
  const headers: Record<string, string> = {};
  if (env.CI_SERVER_URL && url.origin === new URL(env.CI_SERVER_URL).origin) {
    if (!/^[0-9]+$/.test(env.CI_PROJECT_ID ?? "")) throw new Error("Missing CI project identity.");
    const prefix = `/api/v4/projects/${env.CI_PROJECT_ID}/`;
    const suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    if (!/^jobs\/[0-9]+\/artifacts\/[^?]+$/.test(suffix) && !/^packages\/generic\/native-source-input\/[a-zA-Z0-9._-]+\/native-input\.tar\.gz$/.test(suffix)) throw new Error("Private native inputs must come from this project's artifacts or versioned native-source-input Generic Package.");
    if (env.CI_JOB_TOKEN) headers["JOB-TOKEN"] = env.CI_JOB_TOKEN;
  }
  return { url, headers };
}

async function fetchInput() {
  const value = process.env.NATIVE_SOURCE_INPUT_URL;
  const checksum = process.env.NATIVE_SOURCE_INPUT_SHA256;
  if (!value || !checksum) throw new Error("Release compliance needs a controlled native input URL and SHA-256.");
  const { url, headers } = nativeInputRequest(value, checksum, process.env);
  const directory = path.resolve(".cache/native-input");
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, "input.tar.gz");
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Controlled native input unavailable (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(archive));
  if (await fileDigest(archive) !== checksum) throw new Error("Controlled native input checksum mismatch.");
  await extractNativeArchive(archive, path.join(directory, "source"));
  console.log("Controlled native input verified; no source packages downloaded during ordinary branch checks.");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await fetchInput();
