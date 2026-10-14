import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectRuntimeLayers } from "./layers.mts";
import { exportSource } from "./source.mts";
import { fileDigest, PLATFORM, releaseDownload, REPOSITORY, releaseVersion, type BundledNative, type NativePackage, type ReleaseManifest } from "./metadata.mts";

const root = process.cwd();
const output = path.resolve(process.env.RELEASE_OUTPUT ?? ".cache/release");
const version = releaseVersion(process.env.RELEASE_VERSION ?? "1.0.0-rc.1");
const image = process.env.RELEASE_LOCAL_IMAGE ?? `unifi-protect-archive-ui:${version}`;
if (!/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+$/.test(image)) throw new Error("Invalid local release image tag.");
const revision = process.env.PUBLIC_SOURCE_REVISION ?? "";
if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Public source revision must be a public commit SHA, never the private GitLab history.");
const sourceUrl = process.env.PUBLIC_SOURCE_DOWNLOAD_URL ? releaseDownload(process.env.PUBLIC_SOURCE_DOWNLOAD_URL, version, "source.tar.gz") : "";
const created = new Date().toISOString();

async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)));
  });
}
async function archive(directory: string, file: string) {
  await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", file, "-C", directory, "."]);
  return fileDigest(file);
}

const candidates = process.env.PUBLICATION_FILE_LIST ? JSON.parse(await readFile(process.env.PUBLICATION_FILE_LIST, "utf8")) as string[] : undefined;
const exported = await exportSource(root, output, candidates);
const archiveSha256 = await archive(exported.snapshot, path.join(output, "source.tar.gz"));
await run("docker", ["build", "--platform", PLATFORM, "--build-arg", `RELEASE_VERSION=${version}`, "--build-arg", `SOURCE_URL=${REPOSITORY}`,
  "--build-arg", `SOURCE_REVISION=${revision}`, "--build-arg", `SOURCE_DIGEST=${exported.sha256}`, "--build-arg", `SOURCE_DOWNLOAD_URL=${sourceUrl}`,
  "--build-arg", `BUILD_CREATED=${created}`, "-t", image, exported.snapshot]);
const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }))[0];
if (`${inspect.Os}/${inspect.Architecture}` !== PLATFORM || inspect.Config.Labels["io.unifi-protect-archive-ui.source-sha256"] !== exported.sha256 || inspect.Config.Labels["org.opencontainers.image.version"] !== version) throw new Error("Built image/source metadata mismatch.");
await writeFile(path.join(output, "layer-validation.json"), JSON.stringify(await inspectRuntimeLayers(inspect.Id), null, 2) + "\n");
const probe = `const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
const packages=fs.readFileSync('/app/notices/native-packages.tsv','utf8').trim().split('\\n').map(line=>{const [name,version,source,sourceVersion]=line.split('\\t');return {name,version,source,sourceVersion,copyrightSha256:crypto.createHash('sha256').update(fs.readFileSync('/usr/share/doc/'+name.split(':')[0]+'/copyright')).digest('hex')}});
const bundled=['npm','sharp','@img/sharp-linux-x64','@img/sharp-libvips-linux-x64'].filter(name=>fs.existsSync(name==='npm'?'/usr/local/lib/node_modules/npm':'/app/node_modules/'+name)).map(name=>{
 const root=name==='npm'?'/usr/local/lib/node_modules/npm':'/app/node_modules/'+name;
 const meta=JSON.parse(fs.readFileSync(root+'/package.json'));const files=[];
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory()&&entry.name!=='node_modules')walk(file);else if(entry.isFile()&&(/\\.node$|\\.so(?:\\.|$)/.test(entry.name)||['package.json','versions.json','LICENSE'].includes(entry.name)))files.push({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')})}}
 walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));return {name,version:meta.version,license:meta.license,files};
});
console.log(JSON.stringify({node:process.version,packages,bundled}));`;
const native = JSON.parse(execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e", probe], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })) as { node: string; packages: NativePackage[]; bundled: BundledNative[] };
const bundleSha256: string | null = null; // The separate native-compliance stage prepares and validates source artifacts.
await run("docker", ["save", "-o", path.join(output, "image.tar"), image]);
await run("gzip", ["-n", "-f", path.join(output, "image.tar")]);
const manifest: ReleaseManifest = { schema: 1, version, platform: PLATFORM, created,
  source: { sha256: exported.sha256, archiveSha256, repository: REPOSITORY, revision, downloadUrl: sourceUrl },
  image: { name: image, id: inspect.Id, size: inspect.Size, archiveSha256: await fileDigest(path.join(output, "image.tar.gz")) },
  native: { ...native, bundleSha256 } };
await writeFile(path.join(output, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
// The preferred source and artifact manifest are local preparation, not public delivery.
console.log(`Release candidate ${version}: ${inspect.Id}; ${exported.files.length} public source files, digest ${exported.sha256}.`);
console.log(bundleSha256 ? "Native review/source bundle included; publishing still requires all gates." : "Binary release BLOCKED: approved matching native source bundle not supplied.");
// Read the emitted manifest once to ensure a complete artifact was written before success.
JSON.parse(await readFile(path.join(output, "release.json"), "utf8"));
