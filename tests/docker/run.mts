// Docker integration test of the self-hosted distribution (docs/selfhosting.md, docs/testing.md):
// builds the real application image and runs docker-compose.yml exactly as a user would – plus a fake
// UniFi Protect console (compose.test.yaml) – against a temporary archive with synthetic videos.
//
//   node tests/docker/run.mts            all scenarios (~10 min), cleans up afterwards
//   KEEP=1 node tests/docker/run.mts     keep the main stack running for inspection/browser tests
//
// Isolation: every stack has its own project name (unifi-archive-dockertest-*), so containers,
// networks and volumes are separate; only those are removed at the end (`down -v` per project).
// Nothing outside .cache/docker-test/ is written; no other container, network or volume is touched.
// Needs Docker with Compose v2 and `npm ci` (esbuild); no ffmpeg, PostgreSQL or browser on the host.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, cp, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import net from "node:net";
import path from "node:path";

import { build } from "esbuild";

import { isZombie, parseProcessTable, PROCESS_TABLE_FIELDS } from "./process-table.mts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const WORK = path.join(ROOT, ".cache", "docker-test", RUN_ID);
const IMAGE = process.env.DOCKER_TEST_IMAGE ?? `unifi-archive:dockertest-${RUN_ID}`;
const KEEP = process.env.KEEP === "1";
const REQUIRE_SECURITY = process.env.REQUIRE_DOCKER_SECURITY === "1";
const securityResults: { name: string; status: "PASS" | "FAIL" | "NOT TESTED"; detail: string }[] = [];
const PASSWORD = `Pa$$:w/rd@#%&?+ ${randomBytes(4).toString("hex")}`; // URL-hostile on purpose
const FAKE_KEY = "test-api-key-c0ffee-5ecret"; // tests/support/protect-fixtures.ts
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;

const results: { name: string; ok: boolean; detail?: string }[] = [];
const report: Record<string, string> = {};

// --- small helpers ------------------------------------------------------------------------------

// Never let installation settings from the caller override generated test archives/credentials.
// Keep Docker connection settings (for job-private DinD), but isolate Compose interpolation.
function dockerEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(POSTGRES_|PG(?:USER|DATABASE|PASSWORD|HOST|PORT)|UNIFI_ARCHIVE_|NAS_ARCHIVE_|ARCHIVE_|THUMBNAIL_|WORKER_|PROTECT_|UNIFI_PROTECT_|APP_TIME_ZONE$|APP_SOURCE_URL$|FFMPEG_PATH$|FAKE_PROTECT_)/.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

async function sh(cmd: string, args: string[], { allowFail = false, input, env }: { allowFail?: boolean; input?: string; env?: Partial<NodeJS.ProcessEnv> } = {}) {
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: cmd === "docker" ? dockerEnvironment(env) : process.env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.stdin.end(input ?? "");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) reject(new Error(`${cmd} ${args.join(" ")} → exit ${code}\n${out.slice(-3000)}`));
      else resolve({ code: code ?? -1, out });
    });
  });
}

/** Binary pg_dump/restore streaming without shell interpolation or text conversion. */
async function transferFile(stack: Stack, args: string[], file: string, direction: "in" | "out"): Promise<string> {
  const child = spawn("docker", [...stack.composeArgs(), ...args], {
    cwd: ROOT, env: dockerEnvironment(stack.runtimeEnv), stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Docker file transfer failed (${code}): ${errors}`)));
  });
  if (direction === "in") child.stdout.on("data", (chunk) => (output += chunk));
  else child.stdin.end();
  try {
    await Promise.all([
      exited,
      direction === "out" ? pipeline(child.stdout, createWriteStream(file)) : pipeline(createReadStream(file), child.stdin),
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return output;
}

async function check(name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail ? ` – ${detail}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message });
    console.log(`  ✗ ${name}\n    ${(error as Error).message.split("\n").join("\n    ")}`);
    throw error;
  }
}

async function assessSecurity(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    securityResults.push({ name, status: "PASS", detail });
    console.log(`  SECURITY PASS: ${name} – ${detail}`);
  } catch (error) {
    const detail = (error as Error).message;
    securityResults.push({ name, status: "FAIL", detail });
    console.log(`  SECURITY FAIL: ${name} – ${detail}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false | null>, timeoutMs = 90_000, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// --- a stack = one compose project ----------------------------------------------------------------

interface StackOptions {
  label: string;
  protect?: boolean;
  extraEnv?: Record<string, string>;
  overrides?: string[];
  archive?: string;
  sourceFree?: boolean;
}

class Stack {
  readonly project: string;
  readonly dir: string;
  readonly envFile: string;
  readonly archive: string;
  readonly options: StackOptions;
  port = 0;
  controlPort = 0;
  readonly runtimeEnv: Partial<NodeJS.ProcessEnv> = {};

  constructor(options: StackOptions) {
    this.options = options;
    this.project = `unifi-archive-dockertest-${RUN_ID}-${options.label}`;
    this.dir = path.join(WORK, `${RUN_ID}-${options.label}`);
    this.envFile = path.join(this.dir, options.sourceFree ? ".env" : "test.env");
    this.archive = options.archive ?? (options.sourceFree ? path.join(WORK, `${RUN_ID}-source-free-archive`) : path.join(this.dir, "archive"));
  }

  async prepare(): Promise<this> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.archive, { recursive: true });
    if (this.options.sourceFree) await copyFile(path.join(ROOT, "docker-compose.yml"), path.join(this.dir, "docker-compose.yml"));
    this.port = await freePort();
    this.controlPort = await freePort();
    const env: Record<string, string> = {
      // Single quotes: the value is taken literally (documented in docs/selfhosting.md).
      POSTGRES_PASSWORD: `'${PASSWORD}'`,
      NAS_ARCHIVE_HOST_PATH: this.archive,
      // CI fixtures live below the DinD daemon root, where Docker rejects explicit rprivate.
      NAS_ARCHIVE_PROPAGATION: process.env.DOCKER_TEST_ARCHIVE_PROPAGATION ?? "rprivate",
      UNIFI_ARCHIVE_BIND_IP: "127.0.0.1", // Isolated tests never publish on public host interfaces.
      UNIFI_ARCHIVE_PORT: String(this.port),
      APP_SOURCE_URL: "https://source.example.invalid/releases/1.0.0",
      UNIFI_ARCHIVE_IMAGE: IMAGE,
      ARCHIVE_SCAN_INTERVAL_MINUTES: "0.25",
      ARCHIVE_RECONCILE_INTERVAL_MINUTES: "0.1",
      WORKER_HEARTBEAT_INTERVAL_SECONDS: "2",
      WORKER_HEARTBEAT_STALE_SECONDS: "6",
      FAKE_PROTECT_DIR: path.join(WORK, `${RUN_ID}-fake`),
      FAKE_PROTECT_CONTROL_PORT: String(this.controlPort),
      ...(this.options.protect
        ? {
            PROTECT_COLLECTOR_ENABLED: "true",
            UNIFI_PROTECT_URL: "https://fake-protect:8443",
            UNIFI_PROTECT_API_KEY: FAKE_KEY,
            UNIFI_PROTECT_TLS_VERIFY: "false",
          }
        : {}),
      ...this.options.extraEnv,
    };
    await writeFile(this.envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
    return this;
  }

  composeArgs(): string[] {
    const files = this.options.sourceFree ? ["-f", path.join(this.dir, "docker-compose.yml")] : ["-f", "docker-compose.yml", "-f", "tests/docker/compose.test.yaml", ...(this.options.overrides ?? []).flatMap((file) => ["-f", file])];
    return ["compose", "-p", this.project, "--env-file", this.envFile, ...files];
  }

  compose(args: string[], options?: { allowFail?: boolean; input?: string }) {
    return sh("docker", [...this.composeArgs(), ...args], { ...options, env: this.runtimeEnv });
  }

  /** One value from the database (psql inside the postgres container; nothing published). */
  async sql(query: string): Promise<string> {
    const { out } = await this.compose(["exec", "-T", "postgres", "psql", "-U", this.options.extraEnv?.POSTGRES_USER ?? "unifi_archive", "-d", this.options.extraEnv?.POSTGRES_DB ?? "unifi_archive", "-tAqc", query]);
    return out.trim();
  }

  async count(table: string): Promise<number> {
    return Number(await this.sql(`select count(*) from ${table}`));
  }

  async state(component: string): Promise<string> {
    return this.sql(`select coalesce((select state from background_component_status where component = '${component}'), '')`);
  }

  url(pathname: string) {
    const host = this.runtimeEnv.UNIFI_ARCHIVE_BIND_IP ?? this.options.extraEnv?.UNIFI_ARCHIVE_BIND_IP ?? "127.0.0.1";
    return `http://${host}:${this.port}${pathname}`;
  }

  async containerState(service: string): Promise<{ status: string; exitCode: number; restarts: number; health: string }> {
    const { out } = await this.compose(["ps", "-a", "--format", "json", service]);
    const id = (out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { ID: string })[0] ?? { ID: "" }).ID;
    assert(id, `no container for ${service}`);
    const inspect = await sh("docker", ["inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", id]);
    const [status, exitCode, restarts, health] = inspect.out.trim().split("|");
    return { status, exitCode: Number(exitCode), restarts: Number(restarts), health };
  }

  async logs(service: string): Promise<string> {
    return (await this.compose(["logs", "--no-color", service])).out;
  }

  async scanSucceededAfter(since: string): Promise<boolean> {
    return (await this.sql(`select coalesce((select last_succeeded_at > '${since}'::timestamptz from background_component_status where component = 'archiveScan'), false)`)) === "t";
  }

  async down() {
    if (KEEP && this.options.label === "main") return;
    await this.compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  }
}

async function fakeProtect(stack: Stack, route: string, body = ""): Promise<{ sockets: number }> {
  const response = await fetch(`http://127.0.0.1:${stack.controlPort}${route}`, { method: route.endsWith("state") ? "GET" : "POST", body: route.endsWith("state") ? undefined : body });
  return (await response.json()) as { sockets: number };
}

// --- archive with synthetic UniFi exports ------------------------------------------------------

/** UniFi file-name timestamp in Europe/Berlin (`8-10-2026, 8.00.00am GMT+2`). */
function unifiTimestamp(instant: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const hour = Number(p.hour);
  return `${p.month}-${p.day}-${p.year}, ${hour % 12 === 0 ? 12 : hour % 12}.${p.minute}.${p.second}${hour < 12 ? "am" : "pm"} ${p.timeZoneName}`;
}

const SECONDS = 8;
/** Clips of the main scenario (UTC); Driveway + Doorbell at the same moment = one multi-camera event. */
const CLIPS = [
  { camera: "Garden", start: new Date("2026-08-10T06:00:00Z") },
  { camera: "Garden", start: new Date("2026-08-10T09:30:00Z") },
  { camera: "Driveway", start: new Date("2026-08-11T05:00:00Z") },
  { camera: "Doorbell", start: new Date("2026-08-11T05:00:00Z") },
  { camera: "Garden", start: new Date("2026-08-12T16:45:00Z") },
  { camera: "Garage", start: new Date("2026-08-12T18:00:00Z") },
];

function clipRelativePath(camera: string, start: Date, seconds = SECONDS): string {
  const end = new Date(start.getTime() + seconds * 1000);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(start);
  return path.join(`UniFi-Protect_${day}`, `${camera} ${unifiTimestamp(start)} - ${unifiTimestamp(end)}.mp4`);
}

/**
 * Synthetic clips rendered with the image's own ffmpeg (nothing on the host): VP9 in MP4 (plays in
 * Playwright's Chromium, which has no H.264) and H.264 like real UniFi exports (Garage).
 */
async function makeSourceVideos(): Promise<{ vp9: string; h264: string }> {
  const dir = path.join(WORK, `${RUN_ID}-source`);
  await mkdir(dir, { recursive: true });
  const render = (name: string, pattern: string, codec: string[]) =>
    sh("docker", [
      "run", "--rm", "--user", `${UID}:${GID}`, "--network", "none", "-v", `${dir}:/out`, IMAGE,
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${pattern}=size=640x360:rate=15:duration=${SECONDS}`,
      ...codec, "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", "-y", `/out/${name}`,
    ]);
  await render("vp9.mp4", "testsrc2", ["-c:v", "libvpx-vp9", "-b:v", "300k", "-deadline", "realtime", "-cpu-used", "8"]);
  await render("h264.mp4", "smptebars", ["-c:v", "libx264"]);
  return { vp9: path.join(dir, "vp9.mp4"), h264: path.join(dir, "h264.mp4") };
}

async function fillArchive(archive: string, sources: { vp9: string; h264: string }) {
  for (const clip of CLIPS) {
    const target = path.join(archive, clipRelativePath(clip.camera, clip.start));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(clip.camera === "Garage" ? sources.h264 : sources.vp9, target);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).toSorted();
}

// --- docker stats -------------------------------------------------------------------------------

async function sampleStats(stack: Stack, label: string, durationMs: number) {
  const peak: Record<string, { cpu: number; mem: number }> = {};
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const { out } = await sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", ...(await containerNames(stack))]);
    for (const line of out.trim().split("\n")) {
      const [name, cpu, mem] = line.split("|");
      const service = name.replace(`${stack.project}-`, "").replace(/-\d+$/, "");
      const memMiB = parseMem(mem.split("/")[0].trim());
      const entry = (peak[service] ??= { cpu: 0, mem: 0 });
      entry.cpu = Math.max(entry.cpu, parseFloat(cpu));
      entry.mem = Math.max(entry.mem, memMiB);
    }
  }
  report[`stats ${label}`] = Object.entries(peak)
    .map(([service, value]) => `${service}: CPU ≤ ${value.cpu.toFixed(1)} %, RAM ≤ ${value.mem.toFixed(0)} MiB`)
    .join("; ");
  return report[`stats ${label}`];
}

async function containerNames(stack: Stack): Promise<string[]> {
  const { out } = await sh("docker", ["ps", "--filter", `label=com.docker.compose.project=${stack.project}`, "--format", "{{.Names}}"]);
  const names = out.trim().split("\n").filter((name) => name && !name.includes("fake-protect"));
  // `docker stats` without names would show every container of the host.
  assert(names.length > 0, "no containers to measure");
  return names;
}

function parseMem(text: string): number {
  const value = parseFloat(text);
  if (text.endsWith("GiB")) return value * 1024;
  if (text.endsWith("KiB")) return value / 1024;
  if (text.endsWith("B") && !text.endsWith("iB")) return value / 1024 / 1024;
  return value;
}

// --- scenarios ------------------------------------------------------------------------------------

const stacks: Stack[] = [];

async function main() {
  await mkdir(WORK, { recursive: true });
  console.log(`Docker integration test ${RUN_ID} (image ${IMAGE})`);

  console.log("\n[build]");
  await check("application image is built or supplied as a prebuilt release candidate", async () => {
    const started = Date.now();
    const probe = await new Stack({ label: "build" }).prepare();
    await probe.compose(["config", "-q"]);
    if (!process.env.DOCKER_TEST_IMAGE) await sh("docker", ["build", "-t", IMAGE, ROOT]);
    else await sh("docker", ["image", "inspect", IMAGE]);
    report["build"] = `${((Date.now() - started) / 1000).toFixed(0)} s`;
    const size = (await sh("docker", ["image", "inspect", "--format", "{{.Size}}", IMAGE])).out.trim();
    report["image size"] = `${(Number(size) / 1024 / 1024).toFixed(0)} MiB`;
    return `${report.build}, ${report["image size"]}`;
  });
  await check("image contains web, worker, migrations, CLIs and ffmpeg; runs as non-root", async () => {
    const { out } = await sh("docker", [
      "run", "--rm", "--network", "none", "--entrypoint", "sh", IMAGE, "-c",
      "id -u; test -f server.js && test -d .next/static && ls cli/*.mjs | wc -l && ls drizzle/*.sql | wc -l && ffmpeg -version | head -n 1 && node --version && test ! -e .env && test ! -e .env.local && test ! -e node_modules/tsx && test ! -e node_modules/esbuild && test ! -e node_modules/drizzle-kit && test -f notices/packages.json && test -f public/notices/Geist-OFL.txt && test -f public/notices/Lucide-LICENSE.txt && test -f notices/assets/Geist-OFL.txt && test -f LICENSE && test -f THIRD_PARTY_NOTICES.md && test -f public/notices/LICENSE.txt && test -f public/notices/shadcn-LICENSE.txt && test -s notices/native-packages.tsv && echo clean",
    ]);
    const [uid, cliCount, migrations, ffmpeg, node, clean] = out.trim().split("\n");
    assert(uid === "1000", `runs as uid ${uid}`);
    assert(Number(cliCount) === 7, `cli bundles: ${cliCount}`);
    assert(Number(migrations) >= 5, `migrations: ${migrations}`);
    assert(ffmpeg.startsWith("ffmpeg version"), ffmpeg);
    assert(clean === "clean", "image contains .env, tsx or drizzle-kit");
    report["ffmpeg"] = ffmpeg;
    report["node"] = node;
    return `${ffmpeg}; node ${node}; uid ${uid}`;
  });

  // Fake Protect bundle (run inside the app image).
  const fakeDir = path.join(WORK, `${RUN_ID}-fake`);
  await build({
    entryPoints: [path.join(ROOT, "tests/docker/fake-protect-server.mts")],
    outfile: path.join(fakeDir, "fake-protect-server.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning",
    external: ["bufferutil", "utf-8-validate"],
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  await cp(path.join(ROOT, "tests/support/tls"), path.join(fakeDir, "tls"), { recursive: true });
  await chmod(path.join(fakeDir, "tls", "test-only-localhost.key"), 0o644); // readable by uid 1000 in the container
  const source = await makeSourceVideos();

  // ------------------------------------------------------------------------------------------
  console.log("\n[configuration errors]");
  await check("missing POSTGRES_PASSWORD / NAS_ARCHIVE_HOST_PATH: compose refuses with a clear message", async () => {
    const { code, out } = await sh("docker", ["compose", "-p", `unifi-archive-dockertest-${RUN_ID}-noenv`, "--env-file", "/dev/null", "-f", "docker-compose.yml", "config", "-q"], { allowFail: true });
    assert(code !== 0 && /Set POSTGRES_PASSWORD|Set NAS_ARCHIVE_HOST_PATH/.test(out), out);
    return "exit " + code;
  });
  await check("host binding: default LAN, optional localhost and a custom host port publish only web", async () => {
    const cases: { env: Record<string, string>; ip: string; port: string }[] = [
      { env: {}, ip: "0.0.0.0", port: "3100" },
      { env: { UNIFI_ARCHIVE_BIND_IP: "", UNIFI_ARCHIVE_PORT: "" }, ip: "0.0.0.0", port: "3100" },
      { env: { UNIFI_ARCHIVE_BIND_IP: "127.0.0.1", UNIFI_ARCHIVE_PORT: "3200" }, ip: "127.0.0.1", port: "3200" },
      { env: { UNIFI_ARCHIVE_BIND_IP: "198.51.100.10", UNIFI_ARCHIVE_PORT: "3005" }, ip: "198.51.100.10", port: "3005" },
    ];
    for (const item of cases) {
      const env = { POSTGRES_PASSWORD: PASSWORD, NAS_ARCHIVE_HOST_PATH: WORK, ...item.env };
      const config = JSON.parse((await sh("docker", ["compose", "-p", `unifi-archive-dockertest-${RUN_ID}-config`, "--env-file", "/dev/null", "-f", "docker-compose.yml", "config", "--format", "json"], { env })).out);
      for (const service of Object.values(config.services) as Record<string, unknown>[]) {
        for (const key of ["build", "init", "stop_grace_period", "logging"]) assert(!(key in service), `removed Compose option returned: ${key}`);
      }
      assert(["web", "worker", "migrate"].every(name => config.services[name].image === "ghcr.io/dree007/unifi-protect-archive-ui:1.0.1"), "unexpected default GHCR image");
      const ports = config.services.web.ports;
      assert(ports.length === 1 && ports[0].host_ip === item.ip && ports[0].target === 3000, "wrong web binding");
      assert(String(ports[0].published) === item.port, "wrong web port");
      assert(!config.services.web.command, "web must use the image CMD");
      for (const name of ["postgres", "worker", "migrate"]) assert(!config.services[name].ports?.length, `${name} publishes a port`);
      for (const name of ["web", "worker"]) {
        assert(config.services[name].read_only && config.services[name].volumes.find((mount: { target: string }) => mount.target === "/archive").read_only, `${name}: filesystem/ NAS hardening lost`);
      }
    }
    return "0.0.0.0:3100 checked without publishing it; test runtimes bind only loopback or isolated bridges";
  });
  await check("non-existent NAS path: containers are not started, no empty directory is created", async () => {
    const missing = path.join(WORK, `${RUN_ID}-does-not-exist`);
    const stack = await new Stack({ label: "nopath", archive: missing }).prepare();
    await rm(missing, { recursive: true, force: true });
    stacks.push(stack);
    const { code, out } = await stack.compose(["up", "-d", "--no-build", "web"], { allowFail: true });
    assert(code !== 0 && /bind source path does not exist|no such file or directory/i.test(out), out);
    await stat(missing).then(
      () => assert(false, "Docker created the missing archive path"),
      () => undefined,
    );
    return out.trim().split("\n").at(-1);
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[first run: empty database, Protect via fake console]");
  const main = await new Stack({ label: "main", protect: true }).prepare();
  stacks.push(main);
  await fillArchive(main.archive, source);
  const archiveBefore = await listFiles(main.archive);

  await check("docker compose up -d --wait: postgres healthy → migrate → web + worker healthy", async () => {
    const started = Date.now();
    await main.compose(["up", "-d", "--wait", "--wait-timeout", "180"]);
    report["startup (up --wait)"] = `${((Date.now() - started) / 1000).toFixed(0)} s`;
    const migrate = await main.containerState("migrate");
    assert(migrate.status === "exited" && migrate.exitCode === 0, JSON.stringify(migrate));
    const log = await main.logs("migrate");
    assert(/Applied 5 migration\(s\)/.test(log) && /up to date \(5 of 5/.test(log), log);
    for (const service of ["postgres", "web", "worker"]) {
      const state = await main.containerState(service);
      assert(state.status === "running" && state.health === "healthy", `${service}: ${JSON.stringify(state)}`);
    }
    return report["startup (up --wait)"];
  });

  await check("network: PostgreSQL has no host port, web only on 127.0.0.1", async () => {
    const id = (await main.compose(["ps", "-q", "postgres"])).out.trim();
    const published = (await sh("docker", ["port", id])).out.trim();
    assert(published === "", `postgres published: ${published}`);
    const web = (await main.compose(["port", "web", "3000"])).out.trim();
    assert(web === `127.0.0.1:${main.port}`, `web published as ${web}`);
    const config = JSON.parse((await main.compose(["config", "--format", "json"])).out);
    for (const role of ["postgres", "worker", "migrate"]) {
      assert(!config.services[role].ports?.length, `${role} publishes a port`);
    }
    assert(config.services.web.ports.length === 1 && config.services.web.ports[0].host_ip === "127.0.0.1", "extra/IPv6/global web publish");
    for (const service of Object.values(config.services) as { network_mode?: string }[]) {
      assert(service.network_mode !== "host", "host-network bypass");
    }
    const inspected = JSON.parse((await sh("docker", ["inspect", (await main.compose(["ps", "-q", "web"])).out.trim()])).out)[0];
    const bindings = Object.values(inspected.NetworkSettings.Ports).flat().filter(Boolean) as { HostIp: string; HostPort: string }[];
    assert(bindings.length === 1 && bindings[0].HostIp === "127.0.0.1" && bindings[0].HostPort === String(main.port), "unexpected published listener");
    return `web → ${web}`;
  });

  const engineVersion = (await sh("docker", ["info", "--format", "{{.ServerVersion}}"])).out.trim();
  report["Docker Engine"] = engineVersion;
  const supportedEngine = Number(engineVersion.split(".")[0]) >= 28;
  securityResults.push({ name: "Engine security baseline >=28", status: supportedEngine ? "PASS" : "FAIL", detail: engineVersion });
  if (!supportedEngine) {
    securityResults.push({ name: "localhost proxy bypass boundary", status: "NOT TESTED", detail: "Engine <28 has a known localhost publishing weakness; functional scenarios continue separately." });
    console.log(`  SECURITY: Engine ${engineVersion} does not meet >=28; functional tests continue.`);
  } else {
    await assessSecurity("localhost proxy bypass boundary", async () => {
      const network = `${main.project}-boundary-client`;
      await sh("docker", ["network", "create", network]);
      try {
        const gateway = (await sh("docker", ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network])).out.trim();
        const inspected = JSON.parse((await sh("docker", ["inspect", (await main.compose(["ps", "-q", "web"])).out.trim()])).out)[0];
        const appIps = Object.values(inspected.NetworkSettings.Networks).map((item) => (item as { IPAddress: string }).IPAddress);
        const urls = [`http://${gateway}:${main.port}/api/health`, ...appIps.map((ip) => `http://${ip}:3000/api/health`)];
        const result = await sh("docker", ["run", "--rm", "--network", network, "--entrypoint", "node", IMAGE,
          "-e", `Promise.all(${JSON.stringify(urls)}.map(async url => { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } })).then(reachable => process.exit(reachable.some(Boolean) ? 1 : 0))`,
        ], { allowFail: true });
        assert(result.code === 0, `external test client reached the private backend: ${result.out}`);
        return `Engine ${engineVersion}; separate bridge denied host publish and all application IPs`;
      } finally {
        await sh("docker", ["network", "rm", network]);
      }
    });
  }

  await check("container hardening: non-root, read-only NAS/rootfs, dropped capabilities, no worker port", async () => {
    for (const service of ["web", "worker"]) {
      const id = (await main.compose(["ps", "-q", service])).out.trim();
      const container = JSON.parse((await sh("docker", ["inspect", id])).out)[0];
      assert(container.Config.User === "1000:1000", `${service}: unexpected user`);
      assert(!container.HostConfig.Init && !container.Config.StopTimeout, `${service}: init/stop timeout restored`);
      assert(container.HostConfig.ReadonlyRootfs && !container.HostConfig.Privileged, `${service}: rootfs/privileged`);
      assert(container.HostConfig.CapDrop.includes("ALL"), `${service}: capabilities`);
      assert(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"), `${service}: privileges`);
      const archive = container.Mounts.find((mount: { Destination: string }) => mount.Destination === "/archive");
      assert(archive && archive.RW === false, `${service}: archive writable`);
      assert(!container.Mounts.some((mount: { Destination: string }) => mount.Destination.includes("docker.sock")), "Docker socket mounted");
      if (service === "worker") assert((await sh("docker", ["port", id])).out.trim() === "", "worker publishes a port");
    }
    const attempted = await main.compose(["exec", "-T", "web", "node", "-e",
      "try { require('node:fs').writeFileSync('/archive/.readonly-test', 'test'); process.exit(1); } catch(e) { console.log(e.code); process.exit(e.code === 'EROFS' ? 0 : 1); }",
    ]);
    assert(attempted.out.trim() === "EROFS", attempted.out);
    const postgresUser = await main.compose(["exec", "-T", "postgres", "sh", "-c", "awk '/^Uid:/{print $2}' /proc/1/status"]);
    assert(Number(postgresUser.out.trim()) > 0, "PostgreSQL server runs as root");
    return "archive write rejected with EROFS; PostgreSQL server is unprivileged";
  });

  await check("password with special characters works (PGPASSWORD) and appears in no log", async () => {
    const logs = (await main.compose(["logs", "--no-color"])).out;
    assert(!logs.includes(PASSWORD), "password in logs");
    assert(!logs.includes(FAKE_KEY), "API key in logs");
    return "URL-hostile password accepted; no credentials in logs";
  });

  await check("installation without source: only docker-compose.yml and .env, prebuilt image, automatic migrations", async () => {
    const standalone = await new Stack({ label: "source-free", sourceFree: true, extraEnv: { PROTECT_COLLECTOR_ENABLED: "false" } }).prepare();
    stacks.push(standalone);
    await fillArchive(standalone.archive, source);
    assert((await readdir(standalone.dir)).sort().join(",") === ".env,docker-compose.yml", "source-free installation includes source/build tooling");
    await standalone.compose(["up", "-d", "--pull", "never"]);
    await waitFor("source-free web healthy", async () => (await fetch(standalone.url("/api/health"))).status === 200);
    await waitFor("source-free worker healthy", async () => (await standalone.containerState("worker")).health === "healthy");
    assert((await standalone.containerState("migrate")).exitCode === 0, "source-free migration failed");
    await waitFor("source-free indexing", async () => (await standalone.count("archived_clips")) === CLIPS.length);
    for (const name of ["web", "worker"]) {
      const command = (await standalone.compose(["exec", "-T", name, "node", "-e", "console.log(require('node:fs').readlinkSync('/proc/1/exe'))"])).out.trim();
      assert(command === "/usr/local/bin/node", `${name}: PID 1 is not the application: ${command}`);
    }
    await standalone.down();
    return "two installation files, no build/source/NAS write; Node is PID 1, migration/web/worker healthy; pulls disabled only for the local test";
  });

  await check("host-default logging: all roles retain diagnostic stdout/stderr without Compose logging blocks", async () => {
    const driver = (await sh("docker", ["info", "--format", "{{.LoggingDriver}}"])).out.trim();
    for (const name of ["web", "worker", "migrate", "postgres"]) {
      const id = (await main.compose(["ps", "-aq", name])).out.trim();
      const used = (await sh("docker", ["inspect", "--format", "{{.HostConfig.LogConfig.Type}}", id])).out.trim();
      assert(used === driver, `${name}: logging driver differs from host default`);
      assert((await main.logs(name)).trim().length > 0, `${name}: diagnostic logs missing`);
    }
    report["host logging"] = driver;
    return `${driver}; web/worker/migration/PostgreSQL logs available, rotation is the host administrator's responsibility`;
  });

  await check("direct host-IP access: isolated bridge client, one web port, media and legal assets without a proxy", async () => {
    const network = `${main.project}-lan-client`;
    await sh("docker", ["network", "create", network]);
    let lan: Stack | undefined;
    try {
      const gateway = (await sh("docker", ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network])).out.trim();
      lan = await new Stack({ label: "lan", extraEnv: { UNIFI_ARCHIVE_BIND_IP: gateway, PROTECT_COLLECTOR_ENABLED: "false", APP_SOURCE_URL: "" } }).prepare();
      stacks.push(lan);
      await fillArchive(lan.archive, source);
      await lan.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
      await waitFor("LAN archive index", async () => (await lan!.count("archived_clips")) === CLIPS.length);
      const clip = await lan.sql("select id from archived_clips order by start_at limit 1");
      const client = `
        const assert = require('node:assert/strict');
        const base = ${JSON.stringify(lan.url(""))}, clip = ${JSON.stringify(clip)};
        (async () => {
          for (const locale of ['de', 'en']) {
            const response = await fetch(base + '/archive', {headers: {'Accept-Language': locale}});
            assert.equal(response.status, 200); assert.ok((await response.text()).includes('lang="' + locale + '"'));
          }
          const license = await fetch(base + '/notices/LICENSE.txt'); assert.equal(license.status, 200); assert.ok((await license.text()).includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
          const head = await fetch(base + '/api/clips/' + clip + '/video', {method: 'HEAD'}); assert.equal(head.status, 200); assert.equal(head.headers.get('cache-control'), 'no-store');
          const video = await fetch(base + '/api/clips/' + clip + '/video', {headers: {Range: 'bytes=0-31'}}); assert.equal(video.status, 206); assert.equal(video.headers.get('cache-control'), 'no-store'); assert.equal((await video.arrayBuffer()).byteLength, 32);
          const image = await fetch(base + '/api/clips/' + clip + '/thumbnail'); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg'); assert.equal(image.headers.get('cache-control'), 'no-store'); assert.ok((await image.arrayBuffer()).byteLength > 100);
        })().catch(error => { console.error(error.message); process.exit(1); });`;
      await sh("docker", ["run", "--rm", "--network", network, "--entrypoint", "node", IMAGE, "-e", client]);
      const bindings = JSON.parse((await sh("docker", ["inspect", (await lan.compose(["ps", "-q", "web"])).out.trim()])).out)[0].HostConfig.PortBindings;
      assert(Object.values(bindings).flat().length === 1, "LAN web has extra ports");
      const english = await (await fetch(lan.url("/"), { headers: { "Accept-Language": "en" } })).text();
      assert(english.includes("Source publication pending"), "unset source location must be honest and nonblocking for local use");
      return "separate client reaches isolated host bridge IP; GET/HEAD/206/JPEG/DE/EN/license work; no tunnel, proxy or DNS";
    } finally {
      if (lan) await lan.down();
      await sh("docker", ["network", "rm", network]);
    }
  });

  await check("worker: heartbeat, NAS scan, camera sync, Protect connected", async () => {
    await waitFor("worker heartbeat", async () => (await main.state("worker")) === "running");
    await waitFor("all clips indexed", async () => (await main.count("archived_clips")) === CLIPS.length);
    await waitFor("6 cameras synced", async () => (await main.count("cameras")) === 6);
    await waitFor("Protect connected", async () => (await main.state("protect")) === "connected");
    await waitFor("event stream open", async () => (await fakeProtect(main, "/control/state")).sockets === 1);
    const health = await main.compose(["exec", "-T", "worker", "node", "cli/worker-health.mjs"]);
    return health.out.trim();
  });

  const gardenStart = CLIPS[1].start.getTime();
  await check("Protect smart detection → protect_events → reconciliation links it to the clip", async () => {
    const item = {
      id: `dockertest-${RUN_ID}`, modelKey: "event", type: "smartDetectZone",
      start: gardenStart + 1000, end: gardenStart + 6000, device: "660000000000000000000001", smartDetectTypes: ["person"],
    };
    await fakeProtect(main, "/control/event", JSON.stringify({ type: "add", item }));
    await waitFor("protect event stored", async () => (await main.count("protect_events")) === 1);
    await waitFor("event linked to its clip", async () => (await main.count("archive_event_protect_events")) === 1, 60_000);
    const multi = await waitFor("multi-camera event (Driveway + Doorbell)", async () =>
      Number(await main.sql("select count(*) from (select archive_event_id from archive_event_clips group by 1 having count(*) = 2) x")) === 1,
    );
    return `events ${await main.count("archive_events")}, clips ${await main.count("archived_clips")}, multi-camera ${multi}`;
  });

  await check("web: health, dashboard, archive, event detail and system page show real data", async () => {
    const health = await fetch(main.url("/api/health"));
    assert(health.status === 200, `health ${health.status}`);
    const pages = ["/", "/archive", "/cameras", "/system"];
    for (const page of pages) {
      const response = await fetch(main.url(page));
      assert(response.status === 200, `${page} → ${response.status}`);
    }
    const archive = await (await fetch(main.url("/archive"))).text();
    assert(archive.includes("Garden") && archive.includes("Doorbell"), "archive lists no cameras");
    const eventId = await main.sql("select archive_event_id from archive_event_protect_events limit 1");
    const detail = await fetch(main.url(`/archive/${eventId}`));
    assert(detail.status === 200 && (await detail.text()).includes("Garden"), `event detail ${detail.status}`);
    const system = await (await fetch(main.url("/system"))).text();
    assert(system.includes("Connected") && system.includes('lang="en"'), "English fallback does not show Protect as connected");
    const german = await (await fetch(main.url("/system"), { headers: { "Accept-Language": "de-DE;q=0.9,en;q=0.1" } })).text();
    assert(german.includes("Verbunden") && german.includes('lang="de"'), "German system locale does not show Protect as connected");
    return pages.join(", ");
  });

  const clipId = await main.sql(`select id from archived_clips where camera_name = 'Garden' order by start_at limit 1`);
  const otherClipId = await main.sql(`select id from archived_clips where camera_name = 'Garage' limit 1`);
  await check("thumbnail: cache miss → ffmpeg → JPEG in the thumbnail volume, nothing written to the NAS", async () => {
    const response = await fetch(main.url(`/api/clips/${clipId}/thumbnail`));
    assert(response.status === 200 && response.headers.get("content-type") === "image/jpeg", `thumbnail ${response.status} ${response.headers.get("x-thumbnail-error")}`);
    assert(response.headers.get("cache-control") === "no-store", "thumbnail HTTP cache enabled");
    const bytes = (await response.arrayBuffer()).byteLength;
    const files = (await main.compose(["exec", "-T", "web", "find", "/data/thumbnails", "-name", "*.jpg"])).out.trim().split("\n");
    assert(files.length === 1 && files[0].startsWith("/data/thumbnails/"), files.join(","));
    assert(JSON.stringify(await listFiles(main.archive)) === JSON.stringify(archiveBefore), "archive changed");
    const cached = await fetch(main.url(`/api/clips/${clipId}/thumbnail`));
    assert(cached.status === 200 && cached.headers.get("cache-control") === "no-store", "cache hit HTTP policy");
    await cached.arrayBuffer();
    return `${bytes} bytes, ${files[0]}`;
  });

  await check("video: HTTP range request → 206 with Content-Range; full request → 200", async () => {
    const ranged = await fetch(main.url(`/api/clips/${clipId}/video`), { headers: { Range: "bytes=0-1023" } });
    const body = await ranged.arrayBuffer();
    assert(ranged.status === 206 && body.byteLength === 1024, `range ${ranged.status} ${body.byteLength}`);
    const contentRange = ranged.headers.get("content-range") ?? "";
    assert(/^bytes 0-1023\/\d+$/.test(contentRange), contentRange);
    assert(ranged.headers.get("cache-control") === "no-store", "video range HTTP cache enabled");
    const full = await fetch(main.url(`/api/clips/${clipId}/video`));
    const size = (await full.arrayBuffer()).byteLength;
    assert(full.status === 200 && size === (await stat(path.join(main.archive, clipRelativePath("Garden", CLIPS[0].start)))).size, `full ${full.status}`);
    assert(full.headers.get("cache-control") === "no-store", "video HTTP cache enabled");
    for (const [method, headers, status] of [
      ["HEAD", {}, 200],
      ["HEAD", { Range: "bytes=0-1023" }, 206],
      ["GET", { "If-None-Match": full.headers.get("etag")! }, 304],
      ["GET", { Range: "bytes=abc" }, 416],
    ] as [string, Record<string, string>, number][]) {
      const response = await fetch(main.url(`/api/clips/${clipId}/video`), { method, headers });
      assert(response.status === status && response.headers.get("cache-control") === "no-store", `${method} ${status} policy`);
      if (method === "HEAD") assert((await response.arrayBuffer()).byteLength === 0, "HEAD contains bytes");
      else await response.arrayBuffer();
    }
    const web = await main.logs("web");
    assert(!/GET \/api\/clips/.test(web), "web logs every request");
    return `${contentRange}, video/${ranged.headers.get("content-type")?.split("/")[1]}`;
  });

  await check("maintenance CLIs in the running containers (no tsx)", async () => {
    const dry = await main.compose(["exec", "-T", "worker", "node", "cli/archive-scan.mjs", "--dry-run"]);
    assert(dry.out.includes("scan (dry run, nothing written)"), dry.out);
    const reconcile = await main.compose(["exec", "-T", "worker", "node", "cli/archive-reconcile.mjs", "--dry-run"]);
    assert(reconcile.out.includes("reconciliation (dry run, nothing written)"), reconcile.out);
    const media = await main.compose(["exec", "-T", "web", "node", "cli/media-check.mjs", "--clip-id", clipId]);
    assert(/ffmpeg version/i.test(media.out), media.out);
    return "archive-scan --dry-run, archive-reconcile --dry-run, media-check";
  });

  await check("resources: idle", async () => sampleStats(main, "idle", 8000));

  // ------------------------------------------------------------------------------------------
  console.log("\n[restart, shutdown, persistence]");
  const snapshot = async (stack: Stack) =>
    JSON.stringify(await Promise.all(["archived_clips", "archive_events", "archive_event_clips", "protect_events", "archive_event_protect_events", "cameras"].map((t) => stack.count(t))));
  const before = await snapshot(main);

  await check("worker SIGTERM (docker compose stop worker): clean exit 0, status stopped, lock released", async () => {
    const started = Date.now();
    await main.compose(["stop", "worker"]);
    const seconds = (Date.now() - started) / 1000;
    const state = await main.containerState("worker");
    assert(state.status === "exited" && state.exitCode === 0, JSON.stringify(state));
    const log = await main.logs("worker");
    assert(log.includes("SIGTERM received") && log.includes("Worker stopped."), log.slice(-1500));
    assert((await main.state("worker")) === "stopped", "worker row not stopped");
    assert((await main.state("protect")) === "stopped", "protect row not stopped");
    assert(Number(await main.sql("select count(*) from pg_stat_activity where application_name = 'unifi-archive-worker'")) === 0, "worker connections left");
    const health = await main.compose(["run", "--rm", "--no-deps", "-T", "worker", "node", "cli/worker-health.mjs"], { allowFail: true });
    assert(health.code === 1 && health.out.includes("unhealthy: worker stopped"), health.out);
    report["worker stop"] = `${seconds.toFixed(1)} s`;
    return `${seconds.toFixed(1)} s; ${health.out.trim().split("\n").at(-1)}`;
  });

  await check("worker restart: lock, heartbeat, Protect reconnect, scan again – no duplicates", async () => {
    const since = await main.sql("select now()");
    await main.compose(["start", "worker"]);
    await waitFor("worker healthy", async () => (await main.containerState("worker")).health === "healthy");
    await waitFor("Protect reconnected", async () => (await main.state("protect")) === "connected");
    await waitFor("scan after restart", () => main.scanSucceededAfter(since));
    await waitFor("reconciliation after restart", async () =>
      (await main.sql(`select last_succeeded_at > '${since}'::timestamptz from background_component_status where component = 'reconciliation'`)) === "t");
    const after = await snapshot(main);
    assert(after === before, `counts changed: ${before} → ${after}`);
    return `counts ${after}`;
  });

  await check("Protect replays an event after reconnect: no duplicate event or archive links", async () => {
    await fakeProtect(main, "/control/event", JSON.stringify({ type: "add", item: {
      id: `dockertest-${RUN_ID}`, modelKey: "event", type: "smartDetectZone",
      start: gardenStart + 1000, end: gardenStart + 6000, device: "660000000000000000000001", smartDetectTypes: ["person"],
    } }));
    await new Promise((resolve) => setTimeout(resolve, 8000));
    assert((await snapshot(main)) === before, "replayed event duplicated data");
  });

  await check("web restart: thumbnail served from the cache volume without ffmpeg (FFMPEG_PATH broken)", async () => {
    const mtime = (await main.compose(["exec", "-T", "web", "sh", "-c", `stat -c %Y /data/thumbnails/${clipId}-*.jpg`])).out.trim();
    main.runtimeEnv.FFMPEG_PATH = "/nonexistent/ffmpeg";
    try {
      await main.compose(["up", "-d", "--no-build", "--wait", "web"]);
      const cached = await fetch(main.url(`/api/clips/${clipId}/thumbnail`));
      assert(cached.status === 200, `cached thumbnail ${cached.status}`);
      const uncached = await fetch(main.url(`/api/clips/${otherClipId}/thumbnail`));
      assert(uncached.status === 503 && uncached.headers.get("x-thumbnail-error") === "ffmpeg-missing", `uncached ${uncached.status} ${uncached.headers.get("x-thumbnail-error")}`);
      const health = await fetch(main.url("/api/health"));
      assert(health.status === 200, "web unhealthy without ffmpeg");
    } finally {
      delete main.runtimeEnv.FFMPEG_PATH;
    }
    await main.compose(["up", "-d", "--no-build", "--wait", "web"]);
    // ffmpeg back: the H.264 clip (like real UniFi exports) renders now.
    const h264 = await fetch(main.url(`/api/clips/${otherClipId}/thumbnail`));
    assert(h264.status === 200 && h264.headers.get("content-type") === "image/jpeg", `H.264 thumbnail ${h264.status}`);
    const after = (await main.compose(["exec", "-T", "web", "sh", "-c", `stat -c %Y /data/thumbnails/${clipId}-*.jpg`])).out.trim();
    assert(mtime === after, `thumbnail rewritten (${mtime} → ${after})`);
    return "cache hit 200; uncached without ffmpeg → 503 ffmpeg-missing; H.264 thumbnail 200 after restore";
  });

  await check("blocked worker: heartbeat expires, health fails, recovery after SIGCONT", async () => {
    // Namespace PID 1 ignores an in-namespace SIGSTOP; the owning daemon can
    // deliver it from the parent namespace. No privileged test container is needed.
    const signalWorker = async (signal: string) => sh("docker", [
      "kill", "--signal", signal, (await main.compose(["ps", "-q", "worker"])).out.trim(),
    ]);
    await signalWorker("SIGSTOP");
    try {
      await waitFor("stale heartbeat", async () => {
        const result = await main.compose(["exec", "-T", "worker", "node", "cli/worker-health.mjs"], { allowFail: true });
        return result.code === 1 && result.out.includes("stale after");
      }, 30_000);
      await waitFor("worker unhealthy", async () => (await main.containerState("worker")).health === "unhealthy", 30_000);
    } finally {
      await signalWorker("SIGCONT");
    }
    await waitFor("worker healthy again", async () => (await main.containerState("worker")).health === "healthy", 30_000);
    return "stalled event loop detected independently of Protect";
  });

  await check("web SIGTERM (docker compose stop web): exits promptly", async () => {
    const started = Date.now();
    await main.compose(["stop", "web"]);
    const seconds = (Date.now() - started) / 1000;
    const state = await main.containerState("web");
    assert(state.status === "exited" && [0, 143].includes(state.exitCode) && seconds < 10, `${JSON.stringify(state)} after ${seconds} s`);
    await main.compose(["start", "web"]);
    await waitFor("web healthy", async () => (await main.containerState("web")).health === "healthy");
    report["web stop"] = `${seconds.toFixed(1)} s, exit ${state.exitCode}`;
    return report["web stop"];
  });

  await check("web stops an active thumbnail request and real ffmpeg child within the default deadline", async () => {
    const slow = await new Stack({ label: "slow-media", extraEnv: { PROTECT_COLLECTOR_ENABLED: "false", FFMPEG_PATH: "/data/thumbnails/slow-ffmpeg" } }).prepare();
    stacks.push(slow);
    await fillArchive(slow.archive, source);
    await slow.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
    await waitFor("slow-media indexed", async () => (await slow.count("archived_clips")) === CLIPS.length);
    // Test-only executable: real ffmpeg runs in real time, keeping the request active.
    // Never part of the production image or a replacement entrypoint/init process.
    const helper = `#!/usr/local/bin/node\nconst {spawn}=require('node:child_process');\nconst child=spawn('/usr/bin/ffmpeg',['-nostdin','-loglevel','error','-re','-f','lavfi','-i','testsrc2=size=64x64:rate=5','-t','120','-f','null','-'],{stdio:'ignore'});\nlet stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;process.kill(1,'SIGTERM');child.kill('SIGTERM')});\nchild.on('close',()=>process.exit(1));\n`;
    await slow.compose(["exec", "-T", "web", "node", "-e", `require('node:fs').writeFileSync('/data/thumbnails/slow-ffmpeg',${JSON.stringify(helper)},{mode:0o755})`]);
    const clip = await slow.sql("select id from archived_clips order by start_at limit 1");
    const request = fetch(slow.url(`/api/clips/${clip}/thumbnail`)).catch(() => undefined);
    const webId = (await slow.compose(["ps", "-q", "web"])).out.trim();
    await waitFor("real ffmpeg child", async () => {
      const top = (await sh("docker", ["top", webId, "-eo", PROCESS_TABLE_FIELDS])).out;
      const children = parseProcessTable(top).filter((process) => process.command === "ffmpeg" && !isZombie(process));
      return children.length ? children : false;
    });
    const started = Date.now();
    await slow.compose(["stop", "web"]);
    const elapsed = Date.now() - started;
    await request;
    const state = await slow.containerState("web");
    assert(elapsed < 10_000 && [0, 143].includes(state.exitCode), `active media shutdown: ${elapsed}ms, ${state.exitCode}`);
    // Docker PIDs are relative to the daemon, not the CI tool container's /proc.
    // Verify the application PID namespace ended, then inspect the fresh namespace.
    assert((await sh("docker", ["inspect", "--format", "{{.State.Pid}}", webId])).out.trim() === "0", "application PID namespace still running");
    await slow.compose(["start", "web"]);
    await waitFor("slow-media restart", async () => (await fetch(slow.url("/api/health"))).status === 200);
    const top = (await sh("docker", ["top", (await slow.compose(["ps", "-q", "web"])).out.trim(), "-eo", PROCESS_TABLE_FIELDS])).out;
    assert(!parseProcessTable(top).some((process) => isZombie(process) || process.command === "ffmpeg"), "stale ffmpeg/zombie after restart");
    await slow.down();
    return `active request canceled, repeated SIGTERM handled, ffmpeg reaped, restart clean; ${(elapsed / 1000).toFixed(1)} s, exit ${state.exitCode}`;
  });

  for (const job of [{ table: "archived_clips", component: "archiveScan" }, { table: "archive_events", component: "reconciliation" }]) {
    await check(`worker stopped during blocked ${job.component}: bounded exit, locks released, idempotent recovery`, async () => {
      await main.compose(["stop", "worker"]);
      const baseline = await snapshot(main);
      const blocker = main.compose(["exec", "-T", "-e", "PGAPPNAME=dockertest-shutdown-lock", "postgres", "psql", "-U", "unifi_archive", "-d", "unifi_archive", "-tAqc",
        `begin; lock table ${job.table} in access exclusive mode; select pg_sleep(60); rollback;`], { allowFail: true });
      let pid = "";
      try {
        pid = await waitFor("test lock acquired", async () => {
          const value = await main.sql("select pid from pg_stat_activity where application_name = 'dockertest-shutdown-lock' and wait_event = 'PgSleep'");
          return value || false;
        });
        await main.compose(["start", "worker"]);
        await waitFor("worker job blocked", async () => (await main.state(job.component)) === "running", 45_000);
        await waitFor("worker SQL blocked on the test lock", async () => Number(await main.sql("select count(*) from pg_stat_activity where application_name = 'unifi-archive-worker' and wait_event_type = 'Lock'")) > 0);
        const started = Date.now();
        await main.compose(["stop", "worker"]);
        const elapsed = Date.now() - started;
        const state = await main.containerState("worker");
        assert(elapsed < 10_000 && [0, 1].includes(state.exitCode), `worker shutdown ${elapsed}ms, exit ${state.exitCode}`);
      } finally {
        if (pid) await main.sql(`select pg_terminate_backend(${Number(pid)})`);
        await blocker;
      }
      await waitFor("old worker sessions released", async () => (await main.sql("select count(*) from pg_stat_activity where application_name = 'unifi-archive-worker'")) === "0");
      await main.compose(["start", "worker"]);
      await waitFor("recovered worker", async () => (await main.containerState("worker")).health === "healthy");
      await waitFor("recovery reconciliation", async () => (await main.state("reconciliation")) === "success");
      assert((await snapshot(main)) === baseline, "duplicate/inconsistent events after interrupted work");
      return "default stop completes below 10 s; old sessions/locks end; retry keeps identical counts";
    });
  }

  await check("PostgreSQL outage: web reports 503, worker fails closed and comes back by restart policy", async () => {
    await main.compose(["stop", "postgres"]);
    const health = await waitFor("web health 503", async () => (await fetch(main.url("/api/health"))).status === 503, 30_000);
    await waitFor("worker exits (lost lock) and is restarted", async () => (await main.containerState("worker")).restarts > 0, 60_000);
    await main.compose(["start", "postgres"]);
    await waitFor("web healthy again", async () => (await fetch(main.url("/api/health"))).status === 200, 60_000);
    await waitFor("worker healthy again", async () => (await main.containerState("worker")).health === "healthy", 120_000);
    const after = await snapshot(main);
    assert(after === before, `counts changed: ${before} → ${after}`);
    return `web 503 while down (${health}); worker restarts ${(await main.containerState("worker")).restarts}; data intact`;
  });

  await check("docker compose down (without -v) + up: database, status history and thumbnails persist", async () => {
    await main.compose(["down"]);
    await main.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
    const log = await main.logs("migrate");
    assert(/No pending|up to date \(5 of 5/.test(log) && !/Applied/.test(log), log);
    assert((await snapshot(main)) === before, "counts changed");
    assert((await main.sql("select last_succeeded_at is not null from background_component_status where component = 'archiveScan'")) === "t", "status history lost");
    const thumbs = (await main.compose(["exec", "-T", "web", "find", "/data/thumbnails", "-name", "*.jpg"])).out.trim();
    assert(thumbs.length > 0, "thumbnail cache lost");
    return `counts ${before}`;
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[NAS outage]");
  const hidden = path.join(main.dir, "nas-offline");
  await check("NAS gone (mount point empty): scan refused, no clip missing, worker stays healthy", async () => {
    await mkdir(hidden, { recursive: true });
    for (const entry of await readdir(main.archive)) await rename(path.join(main.archive, entry), path.join(hidden, entry));
    const since = await main.sql("select now()");
    await waitFor("refused scan", async () =>
      (await main.sql(`select state || '|' || coalesce(last_error_message, '') from background_component_status where component = 'archiveScan' and last_failed_at > '${since}'`)).startsWith("error|"), 60_000);
    const message = await main.sql("select last_error_message from background_component_status where component = 'archiveScan'");
    assert(message.includes("no MP4 files found"), message);
    const missing = await main.sql("select count(*) from archived_clips where last_seen_at < (select max(started_at) from archive_scan_runs where status = 'completed')");
    assert(missing === "0", `${missing} clips missing`);
    assert((await main.containerState("worker")).health === "healthy", "worker unhealthy");
    const system = await (await fetch(main.url("/system"))).text();
    assert(system.includes("Failed"), "system page shows no scan error");
    return message;
  });
  await check("NAS back: next scan succeeds, nothing lost", async () => {
    for (const entry of await readdir(hidden)) await rename(path.join(hidden, entry), path.join(main.archive, entry));
    const since = await main.sql("select now()");
    await waitFor("scan after reconnect", () => main.scanSucceededAfter(since), 60_000);
    assert((await snapshot(main)) === before, "counts changed");
    return "scan ok";
  });
  await check("archive not readable (EACCES): scan fails, nothing missing", async () => {
    const dayDir = path.join(main.archive, (await readdir(main.archive))[0]);
    await chmod(main.archive, 0o000);
    try {
      const since = await main.sql("select now()");
      await waitFor("failed scan", async () =>
        (await main.sql(`select coalesce((select last_failed_at > '${since}'::timestamptz from background_component_status where component = 'archiveScan'), false)`)) === "t", 60_000);
    } finally {
      await chmod(main.archive, 0o755);
    }
    const message = await main.sql("select last_error_message from background_component_status where component = 'archiveScan'");
    assert(/EACCES|not accessible|permission/i.test(message), message);
    assert(!message.includes(main.archive) && !message.includes(dayDir), "host path leaked into status");
    const since = await main.sql("select now()");
    await waitFor("scan ok again", () => main.scanSucceededAfter(since), 60_000);
    return message;
  });
  await check("ARCHIVE_REQUIRED_FS_TYPE mismatch (empty bind mount in Docker): scan refused", async () => {
    main.runtimeEnv.ARCHIVE_REQUIRED_FS_TYPE = "nfs4,cifs";
    try {
      await main.compose(["up", "-d", "--no-build", "--wait", "worker"]);
      const since = await main.sql("select now()");
      await waitFor("refused scan", async () =>
        (await main.sql(`select coalesce((select last_failed_at > '${since}'::timestamptz from background_component_status where component = 'archiveScan'), false)`)) === "t", 60_000);
    } finally {
      delete main.runtimeEnv.ARCHIVE_REQUIRED_FS_TYPE;
    }
    const message = await main.sql("select last_error_message from background_component_status where component = 'archiveScan'");
    assert(message.includes("expected nfs4 or cifs"), message);
    await main.compose(["up", "-d", "--no-build", "--wait", "worker"]);
    return message;
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[Protect outage]");
  await check("Protect unreachable: worker healthy, scans go on, reconnect afterwards", async () => {
    await waitFor("Protect connected", async () => (await main.state("protect")) === "connected");
    await main.compose(["stop", "fake-protect"]);
    await waitFor("Protect reconnecting", async () => ["reconnecting", "error"].includes(await main.state("protect")), 60_000);
    const since = await main.sql("select now()");
    await waitFor("scan during the outage", () => main.scanSucceededAfter(since), 60_000);
    const health = await main.compose(["exec", "-T", "worker", "node", "cli/worker-health.mjs"]);
    await main.compose(["start", "fake-protect"]);
    await waitFor("Protect connected again", async () => (await main.state("protect")) === "connected", 90_000);
    return health.out.trim();
  });
  await check("Protect API key revoked: authenticationError, worker healthy, key never logged", async () => {
    await fakeProtect(main, "/control/api-key", "another-key");
    await waitFor("authentication error", async () => (await main.state("protect")) === "authenticationError", 60_000);
    const health = await main.compose(["exec", "-T", "worker", "node", "cli/worker-health.mjs"]);
    assert(health.out.startsWith("healthy"), health.out);
    const logs = (await main.compose(["logs", "--no-color"])).out;
    assert(!logs.includes(FAKE_KEY) && !logs.includes(PASSWORD), "secret in logs");
    await fakeProtect(main, "/control/api-key", FAKE_KEY);
    await main.compose(["restart", "worker"]);
    await waitFor("Protect authenticated again", async () => (await main.state("protect")) === "connected");
    return health.out.trim();
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[load]");
  await check("resources: NAS scan + reconciliation of 3,000 more clips, thumbnail generation", async () => {
    const extra = path.join(main.archive, "UniFi-Protect_2026-07-01");
    await mkdir(extra, { recursive: true });
    const sourceFile = path.join(main.archive, clipRelativePath("Garden", CLIPS[0].start));
    for (let i = 0; i < 3000; i++) {
      const start = new Date(Date.UTC(2026, 5, 30, 22, 0, 0) + i * 20_000);
      await link(sourceFile, path.join(main.archive, clipRelativePath(["Garden", "Driveway", "Doorbell"][i % 3], start)));
    }
    const since = await main.sql("select now()");
    const sampling = sampleStats(main, "scan + reconciliation", 25_000);
    await waitFor("scan of 3,006 clips", () => main.scanSucceededAfter(since), 120_000);
    await sampling;
    assert((await main.count("archived_clips")) === CLIPS.length + 3000, "not all clips indexed");
    const ids = (await main.sql("select id from archived_clips where day_directory = 'UniFi-Protect_2026-07-01' limit 6")).split("\n");
    const thumbs = sampleStats(main, "thumbnails (6 × ffmpeg)", 6000);
    await Promise.all(ids.map((id) => fetch(main.url(`/api/clips/${id}/thumbnail`)).then((r) => assert(r.status === 200, `thumbnail ${r.status}`))));
    await thumbs;
    return `${report["stats scan + reconciliation"]} | ${report["stats thumbnails (6 × ffmpeg)"]}`;
  });
  await check("resources: PostgreSQL volume", async () => {
    report["db size"] = await main.sql("select pg_size_pretty(pg_database_size('unifi_archive'))");
    return report["db size"];
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[other failures]");
  await check("wrong database password: migrate fails with a clear message, no password printed", async () => {
    const { code, out } = await main.compose(["run", "--rm", "--no-deps", "-T", "-e", "PGPASSWORD=wrong-Pa55word", "migrate"], { allowFail: true });
    assert(code === 1 && out.includes("password authentication failed"), out);
    assert(!out.includes("wrong-Pa55word") && !out.includes(PASSWORD), "password printed");
    return out.trim().split("\n").at(-1);
  });
  await check("thumbnail cache not writable: media-check names the problem", async () => {
    const { code, out } = await main.compose(["run", "--rm", "--no-deps", "-T", "-e", "THUMBNAIL_CACHE_ROOT=/app/public", "web", "node", "cli/media-check.mjs"], { allowFail: true });
    assert(code !== 0 && /THUMBNAIL_CACHE_ROOT|read-only|EROFS|EACCES/i.test(out), out);
    return out.trim().split("\n").filter((line) => /cache|EROFS|EACCES/i.test(line))[0];
  });
  await check("port already in use: a second installation on the same port fails clearly", async () => {
    const clash = await new Stack({ label: "clash", extraEnv: { UNIFI_ARCHIVE_PORT: String(main.port) } }).prepare();
    stacks.push(clash);
    const { code, out } = await clash.compose(["up", "-d", "--no-build", "web"], { allowFail: true });
    assert(code !== 0 && /port is already allocated|address already in use/i.test(out), out);
    await clash.down();
    return out.trim().split("\n").at(-1);
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[NAS-only: Protect disabled]");
  const nasOnly = await new Stack({ label: "nasonly" }).prepare();
  stacks.push(nasOnly);
  await fillArchive(nasOnly.archive, source);
  await check("without any Protect configuration: everything runs, Protect shown as disabled, no errors", async () => {
    await nasOnly.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web", "worker"]);
    await waitFor("scan", async () => (await nasOnly.count("archived_clips")) === CLIPS.length);
    await waitFor("reconciliation", async () => (await nasOnly.count("archive_events")) > 0);
    assert((await nasOnly.state("protect")) === "disabled", "protect not disabled");
    const logs = await nasOnly.logs("worker");
    assert(logs.includes("UniFi Protect disabled (not configured)") && !logs.includes("[protect]") && !logs.includes(" ERROR "), logs.slice(-1500));
    const system = await (await fetch(nasOnly.url("/system"))).text();
    assert(system.includes("Disabled"), "system page (English fallback)");
    const id = await nasOnly.sql("select id from archived_clips limit 1");
    const video = await fetch(nasOnly.url(`/api/clips/${id}/video`), { headers: { Range: "bytes=100-199" } });
    assert(video.status === 206, `video ${video.status}`);
    const thumb = await fetch(nasOnly.url(`/api/clips/${id}/thumbnail`));
    assert(thumb.status === 200, `thumbnail ${thumb.status}`);
    return `${await nasOnly.count("archive_events")} events from ${CLIPS.length} clips (no cameras synced: no temporal grouping, see docs)`;
  });
  await check("NAS-only temporal fallback with previously synced cameras, no API key", async () => {
    const values = (await main.sql("select json_agg(json_build_object('id', protect_device_id, 'name', name)) from cameras"));
    const cameras = JSON.parse(values) as { id: string; name: string }[];
    for (const camera of cameras) {
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      await nasOnly.sql(`insert into cameras (protect_device_id, name, state) values (${quote(camera.id)}, ${quote(camera.name)}, 'online')`);
    }
    // A rescan assigns known cameras; reconciliation can then group safely.
    await nasOnly.compose(["restart", "worker"]);
    await waitFor("temporal grouping without Protect", async () => Number(await nasOnly.sql(
      "select count(*) from (select archive_event_id from archive_event_clips group by 1 having count(*) = 2) x",
    )) === 1, 60_000);
    assert((await nasOnly.count("protect_events")) === 0, "Protect unexpectedly used");
    assert((await nasOnly.state("protect")) === "disabled", "Protect enabled");
    return "one multi-camera group; no Protect events or API key";
  });
  await nasOnly.down();

  await check("special characters in PostgreSQL user/database names need no URL concatenation", async () => {
    const credentials = await new Stack({ label: "credentials", extraEnv: {
      POSTGRES_USER: "archive @user", POSTGRES_DB: "archive /database",
    } }).prepare();
    stacks.push(credentials);
    await credentials.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web", "worker"]);
    assert((await fetch(credentials.url("/api/health"))).status === 200, "database health failed");
    assert((await credentials.state("worker")) === "running", "worker not running");
    await credentials.down();
    return "PGUSER, PGDATABASE and PGPASSWORD passed separately";
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[migrations]");
  await check("failed migration: transaction rolled back, web and worker never start", async () => {
    const broken = path.join(WORK, `${RUN_ID}-broken-migrations`);
    await cp(path.join(ROOT, "drizzle"), broken, { recursive: true });
    const journalPath = path.join(broken, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
    const last = journal.entries.at(-1)!;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: "9999_broken" });
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(path.join(broken, "9999_broken.sql"), "CREATE TABLE dockertest_partial (id int);\n--> statement-breakpoint\nSELECT 1 / 0;\n");
    const override = path.join(WORK, `${RUN_ID}-broken.yaml`);
    await writeFile(override, `services:\n  migrate:\n    environment:\n      MIGRATIONS_FOLDER: /broken\n    volumes:\n      - type: bind\n        source: ${broken}\n        target: /broken\n        read_only: true\n`);
    const failing = await new Stack({ label: "brokenmig", overrides: [override] }).prepare();
    stacks.push(failing);
    const { code, out } = await failing.compose(["up", "-d", "--no-build", "web", "worker"], { allowFail: true });
    assert(code !== 0 && /didn't complete successfully|exit 1/i.test(out), out);
    for (const service of ["web", "worker"]) {
      const state = await failing.containerState(service).catch(() => ({ status: "absent" }));
      assert(state.status !== "running", `${service} running`);
    }
    const log = await failing.logs("migrate");
    assert(log.includes("Migration failed – no pending migrations were applied") && log.includes("division by zero"), log);
    assert((await failing.sql("select to_regclass('dockertest_partial') is null")) === "t", "partial migration left behind");
    assert((await failing.count("drizzle.__drizzle_migrations")) === 0, "migrations recorded");
    await failing.down();
    return log.trim().split("\n").at(-1);
  });

  await check("upgrade from an older schema with data: only pending migrations run, data survives, no drift", async () => {
    const old = path.join(WORK, `${RUN_ID}-old-migrations`);
    await cp(path.join(ROOT, "drizzle"), old, { recursive: true });
    const journalPath = path.join(old, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, 3); // schema of an earlier release (0000–0002)
    await writeFile(journalPath, JSON.stringify(journal));
    const oldImage = `unifi-archive:dockertest-${RUN_ID}-old`;
    const oldDockerfile = path.join(old, "Dockerfile");
    await writeFile(oldDockerfile, "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY . /app/drizzle/\n");
    await sh("docker", ["build", "--network", "none", "--build-arg", `BASE_IMAGE=${IMAGE}`, "-t", oldImage, old]);
    const upgrade = await new Stack({ label: "upgrade", extraEnv: { UNIFI_ARCHIVE_IMAGE: oldImage, WORKER_RUN_ON_STARTUP: "false" } }).prepare();
    stacks.push(upgrade);
    await upgrade.compose(["up", "-d", "--no-build", "--wait", "postgres"]);
    await upgrade.compose(["up", "-d", "--no-build", "migrate"]);
    await waitFor("old migration completed", async () => (await upgrade.containerState("migrate")).status === "exited");
    assert((await upgrade.containerState("migrate")).exitCode === 0, "old image migration failed");
    await upgrade.sql(`
      insert into cameras (protect_device_id, name, state) values ('660000000000000000000002', 'Driveway', 'online');
      insert into archived_clips (camera_id, camera_name, start_at, end_at, duration_ms, file_path, file_name, day_directory)
        select id, 'Driveway', '2026-03-29T11:01:05Z', '2026-03-29T11:02:18Z', 73000, 'old/a.mp4', 'a.mp4', 'old' from cameras;
      insert into archive_events (start_at, end_at, metadata_status) values ('2026-03-29T11:01:05Z', '2026-03-29T11:02:18Z', 'archiveOnly');
      insert into archive_event_clips select e.id, c.id from archive_events e, archived_clips c;`);
    upgrade.runtimeEnv.UNIFI_ARCHIVE_IMAGE = IMAGE;
    await upgrade.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "migrate", "web", "worker"]);
    const log = await upgrade.logs("migrate");
    assert(/Applied 2 migration\(s\): 0003_temporal_fallback_groups, 0004_background_component_status/.test(log), log);
    assert((await upgrade.count("archive_event_clips")) === 1 && (await upgrade.count("archived_clips")) === 1, "data lost");
    const again = await upgrade.compose(["run", "--rm", "--no-deps", "-T", "migrate"]);
    assert(again.out.includes("up to date (5 of 5") && !again.out.includes("Applied"), again.out);
    const schema = async (stack: Stack) =>
      (await stack.compose(["exec", "-T", "postgres", "pg_dump", "-U", "unifi_archive", "-d", "unifi_archive", "--schema-only", "--no-owner", "--restrict-key=x"])).out;
    assert((await schema(upgrade)) === (await schema(main)), "schema of the upgraded database differs from a fresh one");
    await upgrade.down();
    await sh("docker", ["image", "rm", oldImage]);
    return "0003 + 0004 applied, data kept, schema identical to a fresh install";
  });

  // ------------------------------------------------------------------------------------------
  console.log("\n[backup / restore]");
  await check("pg_dump backup restores into an isolated database with identical counts", async () => {
    const dump = path.join(main.dir, "backup.dump");
    await transferFile(main, ["exec", "-T", "postgres", "pg_dump", "-U", "unifi_archive", "-d", "unifi_archive", "-Fc"], dump, "out");
    const list = await transferFile(main, ["exec", "-T", "postgres", "pg_restore", "--list"], dump, "in");
    const restore = await new Stack({ label: "restore" }).prepare();
    stacks.push(restore);
    await restore.compose(["up", "-d", "--no-build", "--wait", "postgres"]);
    await transferFile(restore, ["exec", "-T", "postgres", "pg_restore", "-U", "unifi_archive", "-d", "unifi_archive", "--no-owner", "--exit-on-error"], dump, "in");
    assert((await snapshot(restore)) === (await snapshot(main)), "restored counts differ");
    await restore.down();
    return `${(await stat(dump)).size} bytes, ${list.split("\n").filter((line) => line.includes("TABLE DATA")).length} tables with data`;
  });

  if (process.env.RUN_DOCKER_E2E === "1") {
    await check("browser E2E over isolated host-IP publication (desktop and mobile viewport)", async () => {
      const previous = process.env.E2E_BASE_URL;
      const network = `${main.project}-browser-lan`;
      await sh("docker", ["network", "create", network]);
      try {
        const gateway = (await sh("docker", ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network])).out.trim();
        main.runtimeEnv.UNIFI_ARCHIVE_BIND_IP = gateway;
        await main.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web"]);
        process.env.E2E_BASE_URL = main.url("");
        await sh("npx", ["playwright", "test", "--project=desktop", "--project=mobile"]);
      } finally {
        if (previous === undefined) delete process.env.E2E_BASE_URL;
        else process.env.E2E_BASE_URL = previous;
        delete main.runtimeEnv.UNIFI_ARCHIVE_BIND_IP;
        await main.compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web"]);
        await sh("docker", ["network", "rm", network]);
      }
      return "host-IP browser access, dashboard, search, media, live status and protected-proxy regressions";
    });
  }

  // ------------------------------------------------------------------------------------------
  console.log("\n[final shutdown]");
  if (!KEEP) {
    await check("docker compose stop: all containers stop cleanly", async () => {
      const started = Date.now();
      await main.compose(["stop"]);
      for (const service of ["web", "worker", "postgres"]) {
        const state = await main.containerState(service);
        assert(state.status === "exited" && [0, 143].includes(state.exitCode), `${service}: ${JSON.stringify(state)}`);
      }
      return `${((Date.now() - started) / 1000).toFixed(1)} s`;
    });
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  for (const stack of stacks.toReversed()) await stack.down();
  if (!KEEP) await rm(WORK, { recursive: true, force: true }).catch(() => {});
}

console.log("\nMeasurements:");
for (const [key, value] of Object.entries(report)) console.log(`  ${key}: ${value}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failed ? " – FAILED" : ""}.`);
if (process.env.DOCKER_TEST_RESULT_FILE) await writeFile(process.env.DOCKER_TEST_RESULT_FILE, JSON.stringify({ imageId: (await sh("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE])).out.trim(), checks: results, security: securityResults }, null, 2) + "\n");
if (KEEP) console.log(`Kept: docker compose -p ${stacks.find((s) => s.options.label === "main")?.project} … (remove with down -v)`);
console.log("\nSeparate host-security assessment:");
for (const result of securityResults) console.log(`  ${result.status}: ${result.name} – ${result.detail}`);
const securityPassed = securityResults.length > 0 && securityResults.every((result) => result.status === "PASS");
if (REQUIRE_SECURITY && !securityPassed) console.log("REQUIRE_DOCKER_SECURITY=1: the separate security gate is not satisfied.");
process.exit(failed || (REQUIRE_SECURITY && !securityPassed) ? 1 : 0);
