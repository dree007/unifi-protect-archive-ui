import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function excludedRuntimePath(value: string) {
  const name = value.replace(/^\.\//, "");
  return /(?:^|\/)node_modules\/@npmcli\/agent(?:\/|$)/.test(name) || /^(?:usr\/local\/(?:lib\/node_modules\/(?:npm|corepack)(?:\/|$)|bin\/(?:npm|npx|corepack)(?:$|\/))|app\/node_modules\/(?:sharp|@img)(?:\/|$))/.test(name);
}

/** Inspect every saved layer, including files later hidden by whiteouts. */
export async function inspectRuntimeLayers(image: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "unifi-image-layers-"));
  try {
    const archive = path.join(directory, "image.tar");
    execFileSync("docker", ["save", "-o", archive, image]);
    execFileSync("tar", ["-xf", archive, "-C", directory]);
    const manifests = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as { Layers: string[] }[];
    const layers = [...new Set(manifests.flatMap((manifest) => manifest.Layers))];
    const findings = layers.flatMap((layer) => {
      if (!/^[a-zA-Z0-9/._-]+$/.test(layer) || layer.split("/").includes("..")) throw new Error("Invalid saved layer path.");
      return execFileSync("tar", ["-tf", path.join(directory, layer)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
        .split("\n").filter(excludedRuntimePath).map((file) => ({ layer, file }));
    });
    if (findings.length) throw new Error(`Excluded runtime payload remains in image layers: ${findings[0].file}`);
    return { image, layers: layers.length, excludedPayloads: 0, status: "PASS" as const };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
