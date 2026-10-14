// Transfers large release archives (image.tar.gz, native-source.tar.gz) between release jobs through
// this project's private Generic Package Registry instead of GitLab job artifacts. Job artifacts
// keep only the small ledgers that pin every archive by SHA-256 (release.json,
// native-compliance.json) plus a transfer record; a consumer never trusts the
// registry or the record alone and verifies the downloaded bytes against the ledger before use.
//
//   node scripts/release/transfer.mts upload <file>           → <dir>/transfer-<file>.json
//   node scripts/release/transfer.mts download <file> [dir]   (SHA-256 from the release ledger)
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { fileDigest } from "./metadata.mts";

/** Generic package that holds the transfer files; one version per producing job (never reused). */
export const TRANSFER_PACKAGE = "release-transfer";
export const TRANSFER_FILES = ["image.tar.gz", "native-source.tar.gz"] as const;
export type TransferFile = (typeof TRANSFER_FILES)[number];

export interface TransferRecord {
  schema: 1;
  file: TransferFile;
  url: string;
  sha256: string;
  size: number;
  /** Producing job; the package version is `job-<id>`, so a retried job never overwrites. */
  jobId: string;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

const SHA256 = /^[a-f0-9]{64}$/;

function isTransferFile(value: string): value is TransferFile {
  return (TRANSFER_FILES as readonly string[]).includes(value);
}

/**
 * The registry location of a transfer file: always this project's own Generic Package API on the
 * CI server, over HTTPS, versioned by the producing job.
 */
export function transferUrl(env: Env, file: TransferFile, jobId = env.CI_JOB_ID): URL {
  const server = new URL(env.CI_SERVER_URL ?? "");
  if (server.protocol !== "https:") throw new Error("Release transfer needs the HTTPS GitLab server of this pipeline.");
  if (!/^[0-9]+$/.test(env.CI_PROJECT_ID ?? "") || !/^[0-9]+$/.test(jobId ?? "")) throw new Error("Missing CI project/job identity.");
  if (!isTransferFile(file)) throw new Error(`Not a release transfer file: ${file}`);
  return new URL(`/api/v4/projects/${env.CI_PROJECT_ID}/packages/generic/${TRANSFER_PACKAGE}/job-${jobId}/${file}`, server.origin);
}

/**
 * Checks that a record (from a job artifact) points exactly at this project's transfer package and
 * pins the same SHA-256 as the release ledger. Returns the URL to download.
 */
export function verifyTransferRecord(record: TransferRecord, expectedSha256: string, env: Env): URL {
  if (!SHA256.test(expectedSha256)) throw new Error("The release ledger does not pin a SHA-256 for this archive.");
  if (record.schema !== 1 || !isTransferFile(record.file)) throw new Error("Unknown release transfer record.");
  if (record.sha256 !== expectedSha256) throw new Error(`Transfer record for ${record.file} does not match the release ledger.`);
  const expected = transferUrl(env, record.file, record.jobId);
  const url = new URL(record.url);
  if (url.href !== expected.href) throw new Error("Transfer record does not point at this project's release-transfer package.");
  return url;
}

function authHeaders(env: Env): Record<string, string> {
  if (!env.CI_JOB_TOKEN) throw new Error("CI_JOB_TOKEN is required for the private release transfer.");
  return { "JOB-TOKEN": env.CI_JOB_TOKEN };
}

/** Uploads a file once (PUT, streamed) and confirms the SHA-256 GitLab stored. */
export async function uploadTransfer(file: string, env: Env, fetchImpl: Fetch = fetch): Promise<TransferRecord> {
  const name = path.basename(file);
  if (!isTransferFile(name)) throw new Error(`Not a release transfer file: ${name}`);
  const url = transferUrl(env, name);
  const sha256 = await fileDigest(file);
  const { size } = await stat(file);
  const target = new URL(url);
  target.searchParams.set("select", "package_file");
  const response = await fetchImpl(target, {
    method: "PUT",
    headers: { ...authHeaders(env), "Content-Type": "application/octet-stream", "Content-Length": String(size) },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream,
    duplex: "half",
    redirect: "error",
    signal: AbortSignal.timeout(1_800_000),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(
      `Release transfer upload of ${name} failed (${response.status})` +
        (response.status === 413 ? ": the GitLab generic package size limit or a proxy body limit is too small." : "."),
    );
  }
  // GitLab reports the stored file (`select=package_file`). Where it reports a checksum or size, it
  // must match; the authoritative check is the consumer's verification against the ledger anyway.
  const stored = (await response.json().catch(() => ({}))) as { file_sha256?: string; size?: number };
  if ((stored.file_sha256 !== undefined && stored.file_sha256 !== sha256) || (stored.size !== undefined && stored.size !== size)) {
    throw new Error(`GitLab stored different bytes for ${name}.`);
  }
  return { schema: 1, file: name, url: url.href, sha256, size, jobId: env.CI_JOB_ID! };
}

/**
 * Downloads a transfer file and verifies it against the SHA-256 of the release ledger. A redirect
 * (object storage) is followed once over HTTPS without the job token; on a mismatch the file is
 * removed, nothing half-verified stays behind.
 */
export async function downloadTransfer(record: TransferRecord, expectedSha256: string, target: string, env: Env, fetchImpl: Fetch = fetch) {
  const url = verifyTransferRecord(record, expectedSha256, env);
  let response = await fetchImpl(url, { headers: authHeaders(env), redirect: "manual", signal: AbortSignal.timeout(1_800_000) });
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get("location") ?? "", url);
    if (location.protocol !== "https:") throw new Error("Release transfer redirect must stay on HTTPS.");
    response = await fetchImpl(location, { redirect: "error", signal: AbortSignal.timeout(1_800_000) });
  }
  if (!response.ok || !response.body) throw new Error(`Release transfer download of ${record.file} failed (${response.status}).`);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(target));
  if ((await fileDigest(target)) !== expectedSha256) {
    await rm(target, { force: true });
    throw new Error(`Downloaded ${record.file} differs from the release ledger.`);
  }
}

/** Transfer record next to the ledgers (a small job artifact). */
export const recordPath = (directory: string, file: TransferFile) => path.join(directory, `transfer-${file}.json`);

/**
 * The SHA-256 that the release ledger – not the transfer record – pins for an archive:
 * image.tar.gz from release.json (release-build), native-source.tar.gz from native-compliance.json.
 */
export async function ledgerSha256(directory: string, file: TransferFile): Promise<string> {
  if (file === "image.tar.gz") {
    const release = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8")) as { image?: { archiveSha256?: string } };
    return release.image?.archiveSha256 ?? "";
  }
  const native = JSON.parse(await readFile(path.join(directory, "native-compliance.json"), "utf8")) as { archiveSha256?: string | null };
  return native.archiveSha256 ?? "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [operation, name, dir] = process.argv.slice(2);
  if ((operation !== "upload" && operation !== "download") || !name || !isTransferFile(path.basename(name))) {
    console.error("Usage: transfer.mts upload <dir>/<image.tar.gz|native-source.tar.gz> | download <image.tar.gz|native-source.tar.gz> [dir]");
    process.exit(2);
  }
  if (operation === "upload") {
    const record = await uploadTransfer(name, process.env);
    await writeFile(recordPath(path.dirname(name), record.file), JSON.stringify(record, null, 2) + "\n");
    console.log(`Transferred ${record.file} (${record.size} bytes, sha256 ${record.sha256}) to the private release-transfer package.`);
  } else {
    const directory = path.resolve(dir ?? process.env.RELEASE_OUTPUT ?? ".cache/release");
    const file = name as TransferFile;
    const expected = await ledgerSha256(directory, file);
    const record = JSON.parse(await readFile(recordPath(directory, file), "utf8")) as TransferRecord;
    await downloadTransfer(record, expected, path.join(directory, file), process.env);
    console.log(`Verified ${file} against the release ledger (sha256 ${expected}).`);
  }
}
