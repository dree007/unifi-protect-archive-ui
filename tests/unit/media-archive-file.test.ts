import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ArchiveFileError,
  openArchiveFile,
  resolveArchiveFile,
  validateRelativeArchivePath,
  type ArchiveFileErrorKind,
} from "@/server/media/archive-file";

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "unifi-archive-media-"));
  root = path.join(base, "archive");
  await mkdir(path.join(root, "2026-03-29"), { recursive: true });
  await writeFile(path.join(root, "2026-03-29", "test.mp4"), "0123456789");
  await mkdir(path.join(root, "2026-03-29", "Garden Ü"), { recursive: true });
  await writeFile(path.join(root, "2026-03-29", "Doorbell 3-29-2026, 1.01.04pm GMT+2 – Größe.mp4"), "abc");
  await writeFile(path.join(root, "2026-03-29", "Garden Ü", "clip.mp4"), "abc");
  // Outside the archive.
  await writeFile(path.join(base, "secret.mp4"), "secret");
  await mkdir(path.join(base, "elsewhere"));
  await writeFile(path.join(base, "elsewhere", "clip.mp4"), "outside");
  // Symlinks inside the archive: to a file outside, to a file inside, a directory outside.
  await symlink(path.join(base, "secret.mp4"), path.join(root, "2026-03-29", "link-out.mp4"));
  await symlink(path.join(root, "2026-03-29", "test.mp4"), path.join(root, "2026-03-29", "link-in.mp4"));
  await symlink(path.join(base, "elsewhere"), path.join(root, "linked-dir"));
  await symlink(path.join(root, "2026-03-29"), path.join(root, "alias-day"));
});

afterAll(() => rm(base, { recursive: true, force: true }));

async function errorKind(promise: Promise<unknown>): Promise<ArchiveFileErrorKind | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof ArchiveFileError) return error.kind;
    throw error;
  }
}

describe("validateRelativeArchivePath", () => {
  it("accepts plain relative paths, including unicode and spaces", () => {
    expect(validateRelativeArchivePath("2026-03-29/test.mp4")).toEqual(["2026-03-29", "test.mp4"]);
    expect(validateRelativeArchivePath("2026-03-29/Garden Ü/Größe – 1.mp4")).toHaveLength(3);
  });

  it("rejects traversal, absolute paths, NUL bytes and odd segments", () => {
    for (const bad of [
      "../secret.mp4",
      "2026-03-29/../../secret.mp4",
      "2026-03-29/..",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "2026-03-29\\..\\secret.mp4",
      "2026-03-29/test.mp4\0.jpg",
      "./2026-03-29/test.mp4",
      "2026-03-29//test.mp4",
      "2026-03-29/",
      "",
      "a/".repeat(3000),
    ]) {
      expect(() => validateRelativeArchivePath(bad), JSON.stringify(bad.slice(0, 40))).toThrow(ArchiveFileError);
    }
    expect(() => validateRelativeArchivePath(undefined)).toThrow(ArchiveFileError);
  });
});

describe("resolveArchiveFile", () => {
  it("resolves an allowed path to a real path inside the real root", async () => {
    const resolved = await resolveArchiveFile(root, "2026-03-29/test.mp4");
    expect(resolved.realPath.endsWith(path.join("archive", "2026-03-29", "test.mp4"))).toBe(true);
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/Doorbell 3-29-2026, 1.01.04pm GMT+2 – Größe.mp4"))).toBe("ok");
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/Garden Ü/clip.mp4"))).toBe("ok");
  });

  it("rejects traversal and absolute paths before touching the file system", async () => {
    expect(await errorKind(resolveArchiveFile(root, "../secret.mp4"))).toBe("invalid-path");
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/../../secret.mp4"))).toBe("invalid-path");
    expect(await errorKind(resolveArchiveFile(root, "/etc/passwd"))).toBe("invalid-path");
    expect(await errorKind(resolveArchiveFile(root, path.join(base, "secret.mp4")))).toBe("invalid-path");
  });

  it("rejects symlinked files, even when they point inside the archive", async () => {
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/link-out.mp4"))).toBe("outside-root");
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/link-in.mp4"))).toBe("outside-root");
  });

  it("rejects symlinked directories on the way", async () => {
    expect(await errorKind(resolveArchiveFile(root, "linked-dir/clip.mp4"))).toBe("outside-root");
    expect(await errorKind(resolveArchiveFile(root, "alias-day/test.mp4"))).toBe("outside-root");
  });

  it("reports missing files and an unusable root", async () => {
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/missing.mp4"))).toBe("not-found");
    expect(await errorKind(resolveArchiveFile(root, "2026-03-29/test.mp4/inner.mp4"))).toBe("not-found");
    expect(await errorKind(resolveArchiveFile(undefined, "2026-03-29/test.mp4"))).toBe("archive-unavailable");
    expect(await errorKind(resolveArchiveFile("relative/root", "2026-03-29/test.mp4"))).toBe("archive-unavailable");
    expect(await errorKind(resolveArchiveFile(path.join(base, "nope"), "2026-03-29/test.mp4"))).toBe("archive-unavailable");
  });

  it("follows a symlinked ARCHIVE_ROOT itself (the mount point), but nothing below it", async () => {
    const aliasRoot = path.join(base, "archive-alias");
    await symlink(root, aliasRoot);
    expect(await errorKind(resolveArchiveFile(aliasRoot, "2026-03-29/test.mp4"))).toBe("ok");
  });
});

describe("openArchiveFile", () => {
  it("opens read-only and reports size and mtime from fstat", async () => {
    const file = await openArchiveFile(root, "2026-03-29/test.mp4");
    try {
      expect(file.size).toBe(10);
      expect(file.modifiedAt).toBeInstanceOf(Date);
      const buffer = Buffer.alloc(4);
      await file.handle.read(buffer, 0, 4, 3);
      expect(buffer.toString()).toBe("3456");
      // Read-only descriptor: writing fails.
      await expect(file.handle.write("x", 0)).rejects.toThrow();
    } finally {
      await file.close();
    }
  });

  it("rejects directories and symlinks", async () => {
    expect(await errorKind(openArchiveFile(root, "2026-03-29"))).toBe("not-a-file");
    expect(await errorKind(openArchiveFile(root, "2026-03-29/link-out.mp4"))).toBe("outside-root");
  });

  it("never puts the archive root into error messages meant for responses", async () => {
    const error = await openArchiveFile(root, "2026-03-29/missing.mp4").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveFileError);
    expect((error as Error).message).not.toContain(root);
  });
});
