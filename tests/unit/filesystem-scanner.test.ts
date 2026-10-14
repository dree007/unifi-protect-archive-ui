import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ArchiveRootError, resolveArchiveRoot } from "@/server/archive/archive-root";
import { classifyStatError, dayDirectoryDate, discoverArchive, type DiscoveryItem } from "@/server/archive/filesystem-scanner";

import { CLIP, createTempArchive } from "../support/archive-fixture";

/** Permission tests are meaningless as root (e.g. in the CI container): root ignores modes. */
const isRoot = process.getuid?.() === 0;

async function collect(root: string): Promise<DiscoveryItem[]> {
  const items: DiscoveryItem[] = [];
  for await (const item of discoverArchive(root, { statConcurrency: 2 })) items.push(item);
  return items;
}

const files = (items: DiscoveryItem[]) =>
  items.flatMap((item) => (item.kind === "file" ? [item.file] : [])).map((file) => file.relativePath).sort();

const ignored = (items: DiscoveryItem[]) =>
  Object.fromEntries(items.flatMap((item) => (item.kind === "ignored" ? [[item.relativePath, item.reason]] : [])));

describe("discoverArchive", () => {
  it("finds MP4 files in several day directories, oldest day first", async () => {
    const archive = await createTempArchive();
    await archive.addFile(`2026-03-30/${CLIP.nextDay}`);
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    await archive.addFile(`2026-03-29/${CLIP.garden}`);
    await archive.addFile(`2026-03-29/${CLIP.doorbell}`);

    const items = await collect(archive.root);

    expect(items.filter((item) => item.kind === "dayDirectory")).toEqual([
      { kind: "dayDirectory", name: "2026-03-29" },
      { kind: "dayDirectory", name: "2026-03-30" },
    ]);
    expect(files(items)).toEqual([
      `2026-03-29/${CLIP.driveway}`,
      `2026-03-29/${CLIP.garden}`,
      `2026-03-29/${CLIP.doorbell}`,
      `2026-03-30/${CLIP.nextDay}`,
    ].sort());
  });

  it("accepts day directories with the UniFi-Protect_ prefix, sorted by date", async () => {
    const archive = await createTempArchive();
    await archive.addFile(`UniFi-Protect_2026-03-30/${CLIP.nextDay}`);
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    await archive.addFile(`UniFi-Protect_2026-03-29/${CLIP.garden}`);

    const items = await collect(archive.root);

    expect(items.filter((item) => item.kind === "dayDirectory")).toEqual([
      { kind: "dayDirectory", name: "2026-03-29" },
      { kind: "dayDirectory", name: "UniFi-Protect_2026-03-29" },
      { kind: "dayDirectory", name: "UniFi-Protect_2026-03-30" },
    ]);
    const prefixed = items.flatMap((item) => (item.kind === "file" ? [item.file] : []));
    expect(prefixed.find((file) => file.fileName === CLIP.nextDay)).toMatchObject({
      relativePath: `UniFi-Protect_2026-03-30/${CLIP.nextDay}`,
      dayDirectory: "UniFi-Protect_2026-03-30",
      dayDate: "2026-03-30",
    });
  });

  it("ignores non-day directories, files in the root and non-MP4 files", async () => {
    const archive = await createTempArchive();
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    await archive.addFile(`@eaDir/${CLIP.garden}`); // Synology metadata folder
    await archive.addFile(`2026-3-29/${CLIP.garden}`); // not YYYY-MM-DD
    await archive.addFile(`Protect_2026-03-29/${CLIP.garden}`); // unknown prefix
    await archive.addFile("README.txt");
    await archive.addFile("2026-03-29/Thumbs.db");
    await archive.addFile(`2026-03-29/${CLIP.doorbell}.part`);
    await archive.mkdir("2026-03-29/nested");

    const items = await collect(archive.root);

    expect(files(items)).toEqual([`2026-03-29/${CLIP.driveway}`]);
    expect(ignored(items)).toEqual({
      "@eaDir": "notDayDirectory",
      "2026-3-29": "notDayDirectory",
      "Protect_2026-03-29": "notDayDirectory",
      "README.txt": "notDayDirectory",
      "2026-03-29/Thumbs.db": "notMp4",
      [`2026-03-29/${CLIP.doorbell}.part`]: "notMp4",
      "2026-03-29/nested": "notRegularFile",
    });
  });

  it("accepts the upper-case .MP4 extension", async () => {
    const archive = await createTempArchive();
    const upper = CLIP.garden.replace(/\.mp4$/, ".MP4");
    await archive.addFile(`2026-03-29/${upper}`);
    expect(files(await collect(archive.root))).toEqual([`2026-03-29/${upper}`]);
  });

  it("does not follow symbolic links out of the archive", async () => {
    const archive = await createTempArchive();
    const outside = await mkdtemp(path.join(tmpdir(), "unifi-archive-outside-"));
    afterAll(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, CLIP.garden), "outside");

    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    await symlink(outside, archive.path("2026-03-30")); // day-directory-shaped link
    await symlink(path.join(outside, CLIP.garden), archive.path(`2026-03-29/${CLIP.garden}`));

    const items = await collect(archive.root);

    expect(files(items)).toEqual([`2026-03-29/${CLIP.driveway}`]);
    expect(ignored(items)).toEqual({
      "2026-03-30": "symlink",
      [`2026-03-29/${CLIP.garden}`]: "symlink",
    });
  });

  it("reports unparseable names as regular files (parsing happens later)", async () => {
    const archive = await createTempArchive();
    await archive.addFile("2026-03-29/defekt.mp4");
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    expect(files(await collect(archive.root))).toEqual([`2026-03-29/${CLIP.driveway}`, "2026-03-29/defekt.mp4"].sort());
  });

  it("reads size and modification time", async () => {
    const archive = await createTempArchive();
    const mtime = new Date("2026-03-29T11:02:20.000Z");
    await archive.addFile(`2026-03-29/${CLIP.driveway}`, { size: 4321, mtime });

    const [file] = (await collect(archive.root)).flatMap((item) => (item.kind === "file" ? [item.file] : []));
    expect(file).toEqual({
      relativePath: `2026-03-29/${CLIP.driveway}`,
      dayDirectory: "2026-03-29",
      dayDate: "2026-03-29",
      fileName: CLIP.driveway,
      sizeBytes: 4321,
      modifiedAt: mtime,
    });
  });

  it("streams many files with bounded concurrency", async () => {
    const archive = await createTempArchive();
    for (let i = 0; i < 25; i++) {
      const s = String(i).padStart(2, "0");
      await archive.addFile(`2026-03-29/Driveway 3-29-2026, 1.00.${s}pm GMT+2 - 3-29-2026, 1.01.${s}pm GMT+2.mp4`, {
        size: 10,
      });
    }
    expect(files(await collect(archive.root))).toHaveLength(25);
  });

  it.skipIf(isRoot)("reports a listed file with unreadable metadata as unreadable (real EACCES)", async () => {
    const archive = await createTempArchive();
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    // Readable but not searchable: entries can be listed, but lstat fails with EACCES.
    await chmod(archive.path("2026-03-29"), 0o444);
    try {
      const items = await collect(archive.root);
      expect(items.filter((item) => item.kind === "fileError")).toEqual([
        {
          kind: "fileError",
          relativePath: `2026-03-29/${CLIP.driveway}`,
          code: "EACCES",
          message: "cannot read file metadata (EACCES)",
          presence: "unreadable",
        },
      ]);
    } finally {
      await chmod(archive.path("2026-03-29"), 0o755);
    }
  });

  it.skipIf(isRoot)("throws when a day directory cannot be listed (real EACCES)", async () => {
    const archive = await createTempArchive();
    await archive.addFile(`2026-03-29/${CLIP.driveway}`);
    await chmod(archive.path("2026-03-29"), 0o000);
    try {
      await expect(collect(archive.root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(archive.path("2026-03-29"), 0o755);
    }
  });

  it("throws when a directory cannot be listed", async () => {
    await expect(collect("/definitely/not/there")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("dayDirectoryDate", () => {
  it.each([
    ["2026-03-29", "2026-03-29"],
    ["UniFi-Protect_2026-03-29", "2026-03-29"],
    ["unifi-protect_2026-03-29", undefined],
    ["UniFi-Protect_2026-3-29", undefined],
    ["UniFi-Protect_2026-03-29_old", undefined],
    ["@eaDir", undefined],
  ])("%s → %s", (name, date) => {
    expect(dayDirectoryDate(name)).toBe(date);
  });
});

describe("resolveArchiveRoot", () => {
  it("accepts an existing absolute directory", async () => {
    const archive = await createTempArchive();
    expect(await resolveArchiveRoot(`${archive.root}/`)).toBe(archive.root);
  });

  it.each([
    [undefined, /not set/],
    ["  ", /not set/],
    ["archive", /absolute/],
    ["/definitely/not/there", /does not exist/],
  ])("rejects %j", async (value, message) => {
    await expect(resolveArchiveRoot(value)).rejects.toThrow(ArchiveRootError);
    await expect(resolveArchiveRoot(value)).rejects.toThrow(message);
  });

  it("rejects a file", async () => {
    const archive = await createTempArchive();
    const file = await archive.addFile("not-a-dir.txt");
    await expect(resolveArchiveRoot(file)).rejects.toThrow(/not a directory/);
  });
});

describe("classifyStatError", () => {
  it.each([
    ["ENOENT", "vanished"],
    ["ENOTDIR", "vanished"],
    ["EACCES", "unreadable"],
    ["EPERM", "unreadable"],
    ["EIO", "unreadable"],
    ["ETIMEDOUT", "unreadable"],
    [undefined, "unreadable"],
  ] as const)("%s → %s", (code, presence) => {
    expect(classifyStatError(code)).toBe(presence);
  });
});
