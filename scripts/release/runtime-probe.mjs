import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cp from "node:child_process";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const noticePattern = /^(?:licen[sc]e|notice|copying|copyright|third[-_]party[-_]notices)(?:[._-].*)?$/i;
const files = new Map();
function record(file) {
  const content = fs.readFileSync(file);
  files.set(file, { path: file, sha256: sha256(content), size: content.length });
}
const packages = cp.execFileSync("dpkg-query", ["-W", "-f", "${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n"], { encoding: "utf8" }).trim().split("\n").map((line) => {
  const [name, version, architecture, source, sourceVersion] = line.split("\t");
  const notice = `/usr/share/doc/${name.split(":")[0]}/copyright`;
  record(notice);
  return { name, version, architecture, source, sourceVersion, notice, copyrightSha256: files.get(notice).sha256 };
});
const npm = [];
const binaries = [];
function walk(directory, owner) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(file, owner);
    else if (entry.name === "package.json") {
      try {
        const meta = JSON.parse(fs.readFileSync(file));
        if (meta.name && meta.version) npm.push({ name: meta.name, version: meta.version, license: meta.license ?? null, directory, metadataSha256: sha256(fs.readFileSync(file)) });
      } catch { /* Non-package JSON is not a component identity. */ }
    } else if (noticePattern.test(entry.name) || file.startsWith("/app/public/notices/") || file.endsWith("sharp-libvips-linux-x64/README.md")) record(file);
    if (entry.isFile()) {
      const fd = fs.openSync(file, "r");
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      if (header.equals(Buffer.from([127, 69, 76, 70]))) {
        record(file);
        binaries.push({ ...files.get(file), owner, linkage: cp.execFileSync("sh", ["-c", 'ldd "$1" 2>&1 || true', "ldd", file], { encoding: "utf8" }).trim() });
      }
    }
  }
}
walk("/app/node_modules", "npm");
walk("/usr/local", "node-runtime");
walk("/app/notices", "notices-only");
walk("/app/public/notices", "notices-only");
for (const file of fs.readdirSync("/usr/share/common-licenses")) record(`/usr/share/common-licenses/${file}`);
record("/app/LICENSE"); record("/app/THIRD_PARTY_NOTICES.md");
const fonts = fs.readdirSync("/app/.next/static/media").filter(name => /\.woff2?$/.test(name)).map(name => {
  const file = `/app/.next/static/media/${name}`;
  return { path: file, sha256: sha256(fs.readFileSync(file)), license: "OFL-1.1", notice: "/app/public/notices/Geist-OFL.txt" };
});
const ffmpeg = {
  version: cp.execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }),
  configuration: cp.execFileSync("ffmpeg", ["-buildconf"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  license: cp.execFileSync("ffmpeg", ["-L"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  linkage: cp.execFileSync("ldd", ["/usr/bin/ffmpeg"], { encoding: "utf8" }),
};
const cliPackages = new Set();
for (const file of fs.readdirSync("/app/cli").filter((name) => name.endsWith(".map"))) {
  for (const source of JSON.parse(fs.readFileSync(`/app/cli/${file}`)).sources) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source);
    if (match) cliPackages.add(match[1]);
  }
}
record("/usr/bin/ffmpeg");
const texts = [...files.values()].filter((file) => noticePattern.test(path.basename(file.path)) || file.path.startsWith("/app/public/notices/") || file.path.includes("/common-licenses/") || file.path.endsWith("sharp-libvips-linux-x64/README.md")).map((file) => ({ ...file, text: fs.readFileSync(file.path, "utf8") }));
const compiledDependencies = ["/app/cli/dependencies.json", "/app/notices/frontend-dependencies.json"].flatMap(file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : []);
process.stdout.write(JSON.stringify({ schema: 1, architecture: process.arch, osRelease: fs.readFileSync("/etc/os-release", "utf8"), node: { version: process.version, components: process.versions, configuration: process.config }, packages, npm, fonts, compiledDependencies, cliPackages: [...cliPackages].sort(), binaries, files: [...files.values()], texts, ffmpeg, libvips: fs.existsSync("/app/node_modules/@img/sharp-libvips-linux-x64/versions.json") ? JSON.parse(fs.readFileSync("/app/node_modules/@img/sharp-libvips-linux-x64/versions.json")) : null, bundledPackages: JSON.parse(fs.readFileSync("/app/notices/packages.json")) }, null, 2));
